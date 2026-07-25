// fe-steward-chat：多模态内容渲染器。
//
// 按 ContentBlock.type 渲染：
//   text  → md-lite（段落 + 行内 `code`，不引完整 md 库，避免依赖膨胀）
//   code  → 代码块（带语言标签 + 复制按钮）
//   image-png / image-svg → <img> 预览（svg 走 data/url 都可）
// html/xml 后续扩展，首版不做。

import { Button } from '@ymesh/ui'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import type { ContentBlock } from './types'

function copyText(text: string) {
  try {
    void navigator.clipboard.writeText(text)
  } catch {
    /* ignore */
  }
}

/** 把 md-lite 文本按段落 + 行内 code 渲染。 */
function renderMdLite(text: string) {
  const paragraphs = text.split(/\n{2,}/)
  return paragraphs.map((p, i) => {
    const inline = splitInlineCode(p)
    return (
      <p key={i} className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
        {inline}
      </p>
    )
  })
}

/** 把行内 `code` 拆成普通文本 + <code> 段。 */
function splitInlineCode(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <code
        key={`c-${m.index}`}
        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground"
      >
        {m[1]}
      </code>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    copyText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div
      data-testid="content-code"
      data-language={language}
      className="relative overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-3 py-1.5">
        <span className="text-xs font-medium text-text-secondary">{language || 'text'}</span>
        <Button
          variant="ghost"
          size="xs"
          data-testid="copy-code"
          onClick={onCopy}
          aria-label="复制代码"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          <span className="ml-1">{copied ? '已复制' : '复制'}</span>
        </Button>
      </div>
      <pre className="overflow-auto p-3 text-xs leading-relaxed">
        <code className="font-mono text-foreground">{code}</code>
      </pre>
    </div>
  )
}

function ImageBlock({
  block,
}: {
  block: { type: 'image-png' | 'image-svg'; src: string; alt?: string }
}) {
  return (
    <div
      data-testid={block.type === 'image-png' ? 'content-image-png' : 'content-image-svg'}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <img
        src={block.src}
        alt={block.alt ?? ''}
        className="max-h-80 max-w-full object-contain"
        loading="lazy"
      />
      {block.alt ? (
        <p className="border-t border-border px-3 py-1.5 text-xs text-text-secondary">{block.alt}</p>
      ) : null}
    </div>
  )
}

export function MultimodalContent({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <div data-testid="content-text" className="flex flex-col gap-2">
          {renderMdLite(block.text)}
        </div>
      )
    case 'code':
      return <CodeBlock language={block.language} code={block.code} />
    case 'image-png':
    case 'image-svg':
      return <ImageBlock block={block} />
  }
}
