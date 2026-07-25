/**
 * 统一剪贴板写入工具：三级降级确保跨环境可用。
 *
 * 1. `navigator.clipboard.writeText` —— HTTPS / localhost / Tauri WKWebView 等 secure context
 * 2. `document.execCommand('copy')` —— HTTP / 老 webview / iframe 等非安全上下文兜底
 * 3. 返回 `false`（caller 让用户从只读 Input 手动复制）
 *
 * covers: 214-page-invite Edge Cases「复制到剪贴板失败」原 V2 兜底提前到本期。
 * 在生产环境是 HTTP / 浏览器扩展拦截 clipboard / Tauri 壳权限缺失等场景下，
 * 用户仍能复制邀请链接（自动降级到 execCommand，全失败时调用方展示可选中输入框）。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof document === 'undefined') return false
  if (!text) return false

  // 1) 优先用 navigator.clipboard（secure context）
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒 / 非 secure context / webview 不支持 → 降级 execCommand
    }
  }

  // 2) 降级 document.execCommand('copy')：通过临时 textarea + select 触发
  //    iOS Safari 需要建 Range 选区，否则 select() 不生效
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    // 防止移动端键盘弹出 + 防止页面滚动
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    textarea.setAttribute('readonly', '')
    document.body.appendChild(textarea)

    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(textarea)
    selection?.removeAllRanges()
    selection?.addRange(range)
    textarea.setSelectionRange(0, text.length)

    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    selection?.removeAllRanges()
    if (ok) return true
  } catch {
    // execCommand 也失败 → 让 caller 展示手动复制 UI
  }

  return false
}
