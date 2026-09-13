/**
 * 队列投递器 —— 把 after_turn / on_reply 的排队消息在正确时机送出去。
 *
 * 为什么需要它：unified agent_message 的两种延迟投递只是「入队」，
 * 光入队没人送等于永远不到。送出去的时机是一条简单的判据：
 *
 *   · on_reply  (target_idle) —— **目标**已经不再活动（回复完了）→ 投给它，
 *                                且以用户口吻（见 unified.wrapForDelivery）
 *   · after_turn(sender_idle) —— **发送方**已经不再活动（本轮结束）→ 投给各目标，
 *                                同目标的积压合并成一条（少唤醒几次，省 token）
 *
 * 设计取舍（无状态）：
 *   不记录「上一轮谁 live」再识别 live→idle 转换——那需要常驻 Set + 首轮 priming，
 *   状态一多就难测也难保证正确。直接看**当前**是否已过 idle 窗口即可：
 *   判据本身幂等（markDelivered 保证只发一次），重启 daemon 也不会重发。
 *
 * 为什么放 daemon：只有 daemon 持续在跑、且本来就在定期扫描。复用它的
 * reconcile 节奏，不新起定时器、不新起进程。
 */

import type { MailboxCore } from '../mailbox/core.js';
import type { SessionStore } from '../store/index.js';
import { coalesce, wrapForDelivery } from '../mailbox/unified.js';

/** 判定「这一轮已经结束」的时间窗（与 store 的 LIVE_THRESHOLD 对齐） */
export const IDLE_AFTER_MS = 120_000;

/** 同一批消息最多尝试投递几次就放弃（消息保留在库，只是不再重试）。 */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface FlushReport {
  /** 本轮送出队列消息条数 */
  flushed: number;
  /** 实际发起的投递次数（合并后） */
  deliveries: number;
  errors: string[];
}

export class DeliveryFlusher {
  constructor(
    private readonly store: SessionStore,
    private readonly core: MailboxCore,
    private readonly log: (line: string) => void = () => {},
    private readonly idleAfterMs: number = IDLE_AFTER_MS,
  ) {}

  /** 目标是否已经不再活动（= 这一轮结束） */
  private isIdle(sessionId: string): boolean {
    const s = this.store.getSession(sessionId);
    if (!s) return false;
    const last = s.fileModifiedAt ?? s.lastSeenAt ?? 0;
    return Date.now() - last >= this.idleAfterMs;
  }

  /**
   * 每次扫描后调用：把「条件已满足」的队列消息投出去。
   * **永不抛错**（daemon 不能因为投递失败而挂掉）。
   */
  async onScanned(): Promise<FlushReport> {
    const report: FlushReport = { flushed: 0, deliveries: 0, errors: [] };
    try {
      await this.flushByPolicy('target_idle', report);
      await this.flushByPolicy('sender_idle', report);
    } catch (err) {
      report.errors.push(String(err));
    }
    // 失败永不静默：投递失败如果不报出来，队列会永远卡着而没人知道。
    for (const e of report.errors) this.log(`[yondermesh] 投递失败: ${e}`);
    return report;
  }

  /**
   * 按投递时机扫一遍队列。
   *
   * 两种 policy 的「谁该已 idle」不同：
   *   target_idle → 看**收件人**（to_session_id）
   *   sender_idle → 看**发件人**（from_session_id）
   * 这里统一成：找出该侧已 idle 的 (session → 它的待投消息集合)。
   */
  private async flushByPolicy(
    policy: 'target_idle' | 'sender_idle',
    report: FlushReport,
  ): Promise<void> {
    const sideColumn = policy === 'target_idle' ? 'to_session_id' : 'from_session_id';

    // 取所有该 policy 的待投消息，按「判活的那一侧」分组
    const rows = this.core.pendingDeliveriesAll(policy);
    if (rows.length === 0) return;

    const groups = new Map<string, typeof rows>();
    // 控制侧为空的历史消息（老版本发送时没能识别出发送方）：
    // 旧实现直接 `continue` —— 不计数、不报错、永远不投，实测 6 条协作通知
    // 就这么烂在库里躺了一天。现在单独收口，在方法末尾降级投递（见下）。
    const orphanSide: typeof rows = [];
    for (const r of rows) {
      const key = sideColumn === 'to_session_id' ? r.toSessionId : r.fromSessionId;
      if (!key) {
        orphanSide.push(r);
        continue;
      }
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    for (const [sid, msgs] of groups) {
      // 限次：目标长期不可达时别每分钟 spawn 一次进程，试够就放弃（消息留在库里）
      if (msgs.every((m) => m.attempts >= MAX_DELIVERY_ATTEMPTS)) {
        this.core.abandonDelivery(
          msgs.map((m) => m.id),
          `投递放弃：目标 ${sid.slice(0, 12)} 连续 ${MAX_DELIVERY_ATTEMPTS} 次未成功（目标可能长期在跑或 CLI 拒绝）`,
        );
        this.log(
          `[yondermesh] 投递放弃（已试 ${MAX_DELIVERY_ATTEMPTS} 次）→ ${sid.slice(0, 12)}，消息仍留在库中`,
        );
        continue;
      }
      if (!this.isIdle(sid)) continue; // 还在忙 → 再等等

      if (policy === 'target_idle') {
        // 目标已静 → 把它收到的一批投给它（用户口吻）
        const body = wrapForDelivery(policy, coalesce(msgs), msgs[0].fromSessionId);
        const ok = await this.deliver(sid, body, report);
        this.core.recordDeliveryAttempt(msgs.map((m) => m.id));
        if (ok) {
          this.core.markDelivered(msgs.map((m) => m.id));
          report.flushed += msgs.length;
          report.deliveries += 1;
          this.log(`[yondermesh] on_reply 投递 → ${sid.slice(0, 12)}（${msgs.length} 条合并）`);
        }
        continue;
      }

      // sender_idle：发送方已静 → 把它攒给**各目标**的消息分别投出去
      const byTarget = new Map<string, typeof msgs>();
      for (const m of msgs) {
        if (!m.toSessionId) continue;
        const list = byTarget.get(m.toSessionId) ?? [];
        list.push(m);
        byTarget.set(m.toSessionId, list);
      }
      for (const [targetId, list] of byTarget) {
        const body = wrapForDelivery(policy, coalesce(list), sid);
        const ok = await this.deliver(targetId, body, report);
        this.core.recordDeliveryAttempt(list.map((m) => m.id));
        if (ok) {
          this.core.markDelivered(list.map((m) => m.id));
          report.flushed += list.length;
          report.deliveries += 1;
          this.log(
            `[yondermesh] after_turn 投递 ${sid.slice(0, 8)} → ${targetId.slice(0, 8)}（${list.length} 条合并）`,
          );
        }
      }
    }

    // ── 控制侧为空的消息：降级投递，绝不静默丢 ─────────────────────────────
    //
    // 没有 from_session_id 的 after_turn 消息永远等不到「发送方 idle」——
    // 这是数据层面的死结，只能降级：目标明确就按 target_idle（等目标空闲）投，
    // 并在正文标注来源未知；目标也没有（项目广播）仍可通过 message check 拉取，
    // 只提示、不误报为失败。
    if (orphanSide.length > 0) {
      const deliverable = orphanSide.filter((m) => m.toSessionId);
      const pullOnly = orphanSide.length - deliverable.length;
      if (pullOnly > 0) {
        this.log(
          `[yondermesh] 队列有 ${pullOnly} 条广播无注入目标（目标可用 message check 拉取）`,
        );
      }
      const byTarget = new Map<string, typeof deliverable>();
      for (const m of deliverable) {
        const list = byTarget.get(m.toSessionId as string) ?? [];
        list.push(m);
        byTarget.set(m.toSessionId as string, list);
      }
      for (const [targetId, list] of byTarget) {
        if (list.every((m) => m.attempts >= MAX_DELIVERY_ATTEMPTS)) {
          this.core.abandonDelivery(
            list.map((m) => m.id),
            `补投降级放弃：来源未知且目标 ${targetId.slice(0, 12)} 连续 ${MAX_DELIVERY_ATTEMPTS} 次未成功`,
          );
          this.log(
            `[yondermesh] 补投降级放弃（来源未知，已试 ${MAX_DELIVERY_ATTEMPTS} 次）→ ${targetId.slice(0, 12)}`,
          );
          continue;
        }
        if (!this.isIdle(targetId)) continue; // 目标还在忙 → 再等等
        const body =
          '[来自另一个 agent 会话（发送方未知，队列补投）]\n' + coalesce(list);
        const ok = await this.deliver(targetId, body, report);
        this.core.recordDeliveryAttempt(list.map((m) => m.id));
        if (ok) {
          this.core.markDelivered(list.map((m) => m.id));
          report.flushed += list.length;
          report.deliveries += 1;
          this.log(
            `[yondermesh] 补投（来源未知）→ ${targetId.slice(0, 12)}（${list.length} 条合并）`,
          );
        }
      }
    }
  }

  /** 单次投递；失败只记错误并返回 false（队列保留，下轮重试）。 */
  private async deliver(targetId: string, body: string, report: FlushReport): Promise<boolean> {
    const target = this.store.getSession(targetId);
    if (!target) {
      report.errors.push(`目标 session 不存在: ${targetId.slice(0, 12)}`);
      return false;
    }
    try {
      const res = await this.core.send({
        cli: target.source,
        sessionId: target.nativeSessionId ?? target.id,
        mode: 'stopped',
        message: body,
        cwd: target.cwd ?? undefined,
      });
      if (!res.delivered) {
        report.errors.push(`投递到 ${targetId.slice(0, 12)} 失败: ${res.error ?? '未知原因'}`);
      }
      return res.delivered;
    } catch (err) {
      report.errors.push(`投递到 ${targetId.slice(0, 12)} 异常: ${String(err)}`);
      return false;
    }
  }
}
