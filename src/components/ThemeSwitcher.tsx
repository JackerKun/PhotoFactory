import { palettes, uiStyles, useTheme, type ThemePalette, type ThemePreference, type UiStyle } from "../hooks/useTheme";
import Icon from "./Icon";

const control = "ui-select w-full";

export default function ThemeSwitcher() {
  const { preference, palette, uiStyle, setPreference, setPalette, setUiStyle } = useTheme();
  return <details className="appearance-settings border-t border-surface-secondary text-sm text-text-secondary">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-surface-primary">
      <Icon name="theme" size={16} /><span>主题</span>
      <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-xs">
        <span className="h-2 w-2 shrink-0 rounded-full bg-accent-link" />
        {palettes[palette]} · {uiStyles[uiStyle]}
      </span>
      <Icon name="chevronUp" size={13} className="appearance-chevron text-text-muted" />
    </summary>
    <div className="space-y-1.5 px-3 pb-3 pt-1">
      <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
        <span>明暗</span>
        <select aria-label="明暗" value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)} className={control}>
          <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
        </select>
      </label>
      <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
        <span>配色</span>
        <select aria-label="配色" value={palette} onChange={(event) => setPalette(event.target.value as ThemePalette)} className={control}>
          {Object.entries(palettes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
        <span>界面风格</span>
        <select aria-label="界面风格" value={uiStyle} onChange={(event) => setUiStyle(event.target.value as UiStyle)} className={control}>
          {Object.entries(uiStyles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>
  </details>;
}
