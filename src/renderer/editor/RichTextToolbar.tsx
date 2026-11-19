import type { ReactNode } from 'react';
import { HelpTip } from '../HelpTip';
import type {
  RichEditorCommand,
  readRichToolbarState,
  FormatState,
} from './editor-commands';

type Props = {
  state: ReturnType<typeof readRichToolbarState>;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onCommand: (command: RichEditorCommand) => void;
  onInsertImage?: () => void;
};

type ToolIconName =
  | 'undo'
  | 'redo'
  | 'paragraph'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'quote'
  | 'bulletList'
  | 'orderedList'
  | 'clearFormat'
  | 'image';

/** Hand-drawn stroke icons keep the toolbar free of an icon dependency. */
const toolIcons: Record<ToolIconName, ReactNode> = {
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a5 5 0 0 1 0 10h-3" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H10a5 5 0 0 0 0 10h3" />
    </>
  ),
  paragraph: (
    <>
      <path d="M5 5h14" />
      <path d="M12 5v14" />
    </>
  ),
  heading: (
    <>
      <path d="M6 5v14" />
      <path d="M18 5v14" />
      <path d="M6 12h12" />
    </>
  ),
  bold: (
    <>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7" />
      <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7" />
      <path d="M7 5v14" />
    </>
  ),
  italic: (
    <>
      <path d="M16 5h-5" />
      <path d="M13 19H8" />
      <path d="M15 5 9 19" />
    </>
  ),
  underline: (
    <>
      <path d="M7 4v6a5 5 0 0 0 10 0V4" />
      <path d="M5 20h14" />
    </>
  ),
  quote: (
    <>
      <path d="M4 5v14" />
      <path d="M9 7h11" />
      <path d="M9 12h11" />
      <path d="M9 17h8" />
    </>
  ),
  bulletList: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  orderedList: (
    <>
      <path d="M10 6h11M10 12h11M10 18h11" />
      <path d="M4 6h1v4" />
      <path d="M4 10h2" />
      <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
    </>
  ),
  clearFormat: (
    <>
      <path d="M4 7V4h16v3" />
      <path d="M5 20h6" />
      <path d="M13 4 8 20" />
      <path d="m15 15 5 5" />
      <path d="m20 15-5 5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
};

function ToolIcon({ name }: { name: ToolIconName }) {
  return (
    <svg
      className="rich-text-tool-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {toolIcons[name]}
    </svg>
  );
}

type ToolAction = {
  label: string;
  icon: ToolIconName;
  run: () => void;
  state?: FormatState;
  block?: boolean;
  unavailable?: boolean;
};

export function RichTextToolbar({
  state,
  disabled,
  canUndo,
  canRedo,
  onCommand,
  onInsertImage,
}: Props) {
  const groups: ToolAction[][] = [
    [
      {
        label: '撤销',
        icon: 'undo',
        run: () => onCommand({ type: 'undo' }),
        unavailable: !canUndo,
      },
      {
        label: '重做',
        icon: 'redo',
        run: () => onCommand({ type: 'redo' }),
        unavailable: !canRedo,
      },
    ],
    [
      {
        label: '正文',
        icon: 'paragraph',
        run: () => onCommand({ type: 'setBlock', block: 'paragraph' }),
        state: state.blocks.paragraph,
        block: true,
      },
      {
        label: '小标题',
        icon: 'heading',
        run: () => onCommand({ type: 'setBlock', block: 'heading' }),
        state: state.blocks.heading,
        block: true,
      },
    ],
    [
      {
        label: '加粗',
        icon: 'bold',
        run: () => onCommand({ type: 'toggleMark', mark: 'bold' }),
        state: state.marks.bold,
        block: true,
      },
      {
        label: '斜体',
        icon: 'italic',
        run: () => onCommand({ type: 'toggleMark', mark: 'italic' }),
        state: state.marks.italic,
        block: true,
      },
      {
        label: '下划线',
        icon: 'underline',
        run: () => onCommand({ type: 'toggleMark', mark: 'underline' }),
        state: state.marks.underline,
        block: true,
      },
    ],
    [
      {
        label: '引用',
        icon: 'quote',
        run: () => onCommand({ type: 'toggleQuote' }),
        state: state.blocks.blockquote,
        block: true,
      },
      {
        label: '无序列表',
        icon: 'bulletList',
        run: () => onCommand({ type: 'toggleList', kind: 'bullet' }),
        state: state.blocks.bullet_list,
        block: true,
      },
      {
        label: '有序列表',
        icon: 'orderedList',
        run: () => onCommand({ type: 'toggleList', kind: 'ordered' }),
        state: state.blocks.ordered_list,
        block: true,
      },
    ],
    [
      {
        label: '清除格式',
        icon: 'clearFormat',
        run: () => onCommand({ type: 'clearFormatting' }),
      },
      ...(onInsertImage
        ? [
            {
              label: '插入图片',
              icon: 'image' as const,
              run: onInsertImage,
            },
          ]
        : []),
    ],
  ];
  return (
    <div className="rich-text-tools" role="toolbar" aria-label="正文格式">
      {groups.map((actions, index) => (
        <div className="rich-text-tool-group" key={index}>
          {actions.map((action) => {
            const reason = action.block ? state.blockDisabledReason : undefined;
            return (
              <button
                key={action.label}
                type="button"
                aria-label={action.label}
                aria-pressed={
                  action.state === undefined
                    ? undefined
                    : action.state === 'mixed'
                      ? 'mixed'
                      : action.state === 'on'
                }
                disabled={disabled || !!reason || action.unavailable}
                aria-describedby={
                  reason ? 'rich-format-selection-help' : undefined
                }
                title={
                  reason
                    ? `${action.label}：${reason}`
                    : action.state === 'mixed'
                      ? `${action.label}（混合格式）`
                      : action.label
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={action.run}
              >
                <ToolIcon name={action.icon} />
              </button>
            );
          })}
        </div>
      ))}
      {state.blockDisabledReason && (
        <span id="rich-format-selection-help" className="hint">
          {state.blockDisabledReason}，请选择不含图片的文字段落后设置格式
        </span>
      )}
      <HelpTip label="正文格式帮助">
        加粗、斜体、下划线、小标题、列表、引用会一并写入平台草稿。
      </HelpTip>
    </div>
  );
}
