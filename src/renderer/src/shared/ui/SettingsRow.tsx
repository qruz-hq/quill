import { Children, Fragment, type HTMLAttributes, type ReactNode } from 'react'
import './settings-row.css'

/** One settings line: title + description on the left, a control on the right. */
export function SettingsRow({ title, desc, children, className, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title: ReactNode; desc?: ReactNode; children?: ReactNode
}): React.JSX.Element {
  return (
    <div className={['q-row', className].filter(Boolean).join(' ')} {...rest}>
      <div className="q-row__text">
        <div className="q-row__title">{title}</div>
        {desc != null && desc !== '' && <div className="q-row__desc">{desc}</div>}
      </div>
      {children != null && <div className="q-row__control">{children}</div>}
    </div>
  )
}

/** A rounded card of SettingsRows with a 1px divider between each (falsy children are skipped). */
export function SettingsGroup({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const rows = Children.toArray(children)
  return (
    <div className={['q-group', className].filter(Boolean).join(' ')} {...rest}>
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="q-group__divider" aria-hidden />}
          {row}
        </Fragment>
      ))}
    </div>
  )
}
