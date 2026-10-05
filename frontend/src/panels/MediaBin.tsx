import { EmptyState, Panel } from './Panel'

export function MediaBin() {
  return (
    <Panel title="Медиа">
      <EmptyState title="Нет файлов" hint="Импорт видео и музыки — фаза 1" />
    </Panel>
  )
}
