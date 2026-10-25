import styles from './Button.module.css'
import icon from './save.svg?raw'

export function Button({ label }: { label: string }) {
  return (
    <button
      className={styles.primary}
      data-icon={icon.includes('<svg')}
      type="button"
    >
      {label}
    </button>
  )
}
