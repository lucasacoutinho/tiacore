import copy from './badge.json'

export function Badge({ text }: { text: string }) {
  return (
    <span aria-label="status" data-copy={copy.label}>
      {text}
    </span>
  )
}
