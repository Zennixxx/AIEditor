import { EmptyState, Panel } from './Panel'

export function Inspector() {
  return (
    <Panel title="Инспектор">
      <EmptyState title="Ничего не выбрано" hint="Свойства клипа, маркера или эффекта" />
    </Panel>
  )
}
