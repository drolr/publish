import type { CoverMode } from '../../contracts/article-cover';
/** Shared mode controls; callers own persistence and allowed modes. */
export function CoverModeControls({
  mode,
  disabled,
  onChange,
  modes = ['none', 'single', 'triple'],
}: {
  mode: CoverMode;
  disabled: boolean;
  onChange(mode: CoverMode): void;
  modes?: readonly CoverMode[];
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>封面模式</legend>
      {modes.map((value) => (
        <label key={value}>
          <input
            type="radio"
            name="cover-mode"
            checked={mode === value}
            onChange={() => onChange(value)}
          />
          {value === 'none' ? '无封面' : value === 'single' ? '单图' : '三图'}
        </label>
      ))}
    </fieldset>
  );
}
