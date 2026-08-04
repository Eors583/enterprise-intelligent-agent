import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface EntityOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function mergeEntityOptions(
  options: readonly EntityOption[],
  selectedIds: readonly string[],
): EntityOption[] {
  const known = new Set(options.map((option) => option.id));
  return [
    ...options,
    ...selectedIds
      .filter((id) => !known.has(id))
      .map((id) => ({
        id,
        label: `已保存的对象 · ${shortId(id)}`,
        description: id,
      })),
  ];
}

export function EntitySelect({
  value,
  options,
  onChange,
  placeholder = '请选择',
  required = false,
  disabled = false,
  ariaLabel,
}: {
  value: string;
  options: readonly EntityOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}): ReactNode {
  const merged = mergeEntityOptions(options, value ? [value] : []);
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      required={required}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <option value="">{placeholder}</option>
      {merged.map((option) => (
        <option key={option.id} value={option.id} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function EntityMultiPicker({
  value,
  options,
  onChange,
  ariaLabel,
  emptyText = '暂无可选择项',
  disabled = false,
}: {
  value: readonly string[];
  options: readonly EntityOption[];
  onChange: (value: string[]) => void;
  ariaLabel: string;
  emptyText?: string;
  disabled?: boolean;
}): ReactNode {
  const [query, setQuery] = useState('');
  const merged = useMemo(() => mergeEntityOptions(options, value), [options, value]);
  const selected = new Set(value);
  const filtered = merged.filter((option) => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return (
      normalized === '' ||
      option.label.toLocaleLowerCase('zh-CN').includes(normalized) ||
      option.description?.toLocaleLowerCase('zh-CN').includes(normalized)
    );
  });
  const toggle = (id: string): void => {
    onChange(selected.has(id) ? value.filter((candidate) => candidate !== id) : [...value, id]);
  };

  return (
    <div className="entity-multi-picker" aria-label={ariaLabel}>
      <div className="entity-picker-search">
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`搜索${ariaLabel}`}
          aria-label={`搜索${ariaLabel}`}
          disabled={disabled}
        />
        <small>已选 {value.length}</small>
      </div>
      <div className="entity-picker-options">
        {filtered.map((option) => (
          <label key={option.id}>
            <input
              type="checkbox"
              checked={selected.has(option.id)}
              disabled={disabled || option.disabled}
              onChange={() => toggle(option.id)}
            />
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </label>
        ))}
        {filtered.length === 0 ? <p>{emptyText}</p> : null}
      </div>
    </div>
  );
}

export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，;；]+/u)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

export function TagInput({
  value,
  onChange,
  ariaLabel,
  placeholder = '输入后按回车',
  disabled = false,
}: {
  value: readonly string[];
  onChange: (value: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const commit = (): void => {
    const additions = parseTags(draft);
    if (additions.length > 0) onChange([...new Set([...value, ...additions])]);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault();
    commit();
  };

  return (
    <div className="tag-input" aria-label={ariaLabel}>
      <div className="tag-input-values">
        {value.map((tag) => (
          <span key={tag}>
            {tag}
            <button
              type="button"
              aria-label={`移除 ${tag}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((candidate) => candidate !== tag))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
      />
    </div>
  );
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
