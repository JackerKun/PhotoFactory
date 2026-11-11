import { useTheme, type ThemePreference } from "../hooks/useTheme";
import Icon from "./Icon";

export default function ThemeSwitcher() {
  const { preference, setPreference } = useTheme();
  return <label className="flex items-center gap-2 border-t border-surface-secondary px-4 py-3 text-sm text-text-secondary">
    <Icon name="theme" /><span>主题</span>
    <select aria-label="主题" value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)} className="ml-auto min-w-0 rounded-lg border border-surface-secondary bg-bg-secondary px-2 py-1 text-text-primary">
      <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
    </select>
  </label>;
}
