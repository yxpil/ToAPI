import type { KvRow } from '@shared/types'
import { Icon } from '../../components/Icon'

interface Props {
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  emptyText?: string
}

const blank = (): KvRow => ({ key: '', value: '', enabled: true, desc: '' })

export function KvTable({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  emptyText = '暂无内容',
}: Props) {
  const patch = (index: number, next: Partial<KvRow>): void => {
    const copy = rows.map((r, i) => (i === index ? { ...r, ...next } : r))
    if (index === rows.length - 1 && next.key !== undefined) copy.push(blank())
    onChange(copy)
  }

  return (
    <table className="kv-table">
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.key}-${index}`}>
            <td style={{ width: 28 }}>
              <input
                type="checkbox"
                checked={row.enabled}
                aria-label="启用该行"
                onChange={(e) => patch(index, { enabled: e.target.checked })}
              />
            </td>
            <td style={{ width: '32%' }}>
              <input
                type="text"
                value={row.key}
                placeholder={keyPlaceholder}
                aria-label="键"
                onChange={(e) => patch(index, { key: e.target.value })}
              />
            </td>
            <td>
              <input
                type="text"
                value={row.value}
                placeholder={valuePlaceholder}
                aria-label="值"
                onChange={(e) => patch(index, { value: e.target.value })}
              />
            </td>
            <td style={{ width: '24%' }}>
              <input
                type="text"
                value={row.desc}
                placeholder="说明"
                aria-label="说明"
                onChange={(e) => patch(index, { desc: e.target.value })}
              />
            </td>
            <td style={{ width: 32 }}>
              <button
                className="pill ghost"
                title="删除该行"
                aria-label="删除该行"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <Icon name="minus" size={14} />
              </button>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={5}>
              <div className="kv-empty">
                <span>{emptyText}</span>
                <button className="pill" title="添加一行" onClick={() => onChange([blank()])}>
                  <Icon name="plus" size={14} /> 添加一行
                </button>
              </div>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
