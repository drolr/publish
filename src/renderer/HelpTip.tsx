import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export function HelpTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 16 });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  function showHelp() {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }
  function hideHelp() {
    clearTimeout(closeTimer.current);
    setOpen(false);
  }
  function leaveHelp() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(false);
    }, 100);
  }

  useEffect(() => {
    if (!open) return;
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      clearTimeout(closeTimer.current);
      setOpen(false);
    }
    window.addEventListener('keydown', dismissOnEscape, true);
    return () => window.removeEventListener('keydown', dismissOnEscape, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function positionTooltip() {
      if (!trigger.current || !tooltip.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = tooltip.current.getBoundingClientRect();
      const below = anchor.bottom + 8;
      const footerHeight =
        Number.parseFloat(
          getComputedStyle(
            trigger.current.closest('main') ?? document.documentElement,
          ).getPropertyValue('--workspace-footer-height'),
        ) || 0;
      const visibleBottom = window.innerHeight - footerHeight - 16;
      setPosition({
        left: Math.max(
          16,
          Math.min(anchor.left, window.innerWidth - box.width - 16),
        ),
        top:
          below + box.height <= visibleBottom
            ? below
            : Math.max(16, anchor.top - box.height - 8),
      });
    }
    positionTooltip();
    window.addEventListener('resize', positionTooltip);
    window.addEventListener('scroll', positionTooltip, true);
    return () => {
      window.removeEventListener('resize', positionTooltip);
      window.removeEventListener('scroll', positionTooltip, true);
    };
  }, [open]);

  return (
    <span className="help-tip" onMouseEnter={showHelp} onMouseLeave={leaveHelp}>
      <button
        ref={trigger}
        type="button"
        className="help-trigger"
        aria-label={label}
        aria-describedby={id}
        onFocus={showHelp}
        onBlur={hideHelp}
        onClick={showHelp}
      >
        <span aria-hidden="true">?</span>
      </button>
      {createPortal(
        <span
          ref={tooltip}
          id={id}
          role="tooltip"
          className="help-content"
          hidden={!open}
          style={position}
        >
          {children}
        </span>,
        document.body,
      )}
    </span>
  );
}
