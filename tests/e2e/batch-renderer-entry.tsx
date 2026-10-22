import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import {
  OperationControls,
  useOperationControl,
} from '../../src/renderer/OperationControls';
import { BatchCoverPanel } from '../../src/renderer/covers/BatchCoverPanel';
import { BatchPanel } from '../../src/renderer/drafts/BatchPanel';
import '../../src/renderer/tokens.css';
let root = createRoot(document.getElementById('root')!);
function BatchHarness() {
  const [fixed, setFixed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [configurationBlocked, setConfigurationBlocked] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [keys, setKeys] = useState(['11111111-1111-4111-8111-111111111111']);
  Object.assign(window, {
    changeBatchSelection: (next: string[]) => setKeys(next),
    fixBatchBar: () => setFixed(true),
    freezeBatchConfiguration: (value: boolean) =>
      setConfigurationBlocked(value),
    blockBatchActions: (value: boolean) => setBlocked(value),
  });
  Object.assign(window, { resetBatch: () => setGeneration((v) => v + 1) });
  return (
    <BatchPanel
      articleKeys={keys}
      configurationBlocked={configurationBlocked}
      blocked={blocked}
      stopControl={fixed ? <button>停止所有未完成操作</button> : undefined}
      operationGeneration={() => generation}
      beforeWrite={async () => Reflect.get(window, 'handoverBlocked') !== true}
    />
  );
}
function render() {
  root.render(<BatchHarness />);
}
render();
Object.assign(window, {
  remountBatch: () => {
    root.unmount();
    root = createRoot(document.getElementById('root')!);
    render();
  },
});

function CoversHarness() {
  const [generation, setGeneration] = useState(0),
    [epoch, setEpoch] = useState(0),
    [keys, setKeys] = useState([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  Object.assign(window, { changeCoverSelection: () => setKeys([keys[1]]) });
  return (
    <>
      <BatchCoverPanel
        articleKeys={keys}
        contentEpoch={epoch}
        operationGeneration={() => generation}
        beforeWrite={async () => true}
        onChanged={() => setEpoch((v) => v + 1)}
        onEdit={(key) => Reflect.set(window, 'editedCover', key)}
      />
      <div style={{ height: 2000 }}>本地文章池占位</div>
      <BatchPanel
        articleKeys={keys}
        contentEpoch={epoch}
        beforeWrite={async () => true}
        stopControl={
          <button onClick={() => setGeneration((v) => v + 1)}>
            停止所有未完成操作
          </button>
        }
      />
    </>
  );
}
Object.assign(window, {
  renderBatchCoverHarness: () => root.render(<CoversHarness />),
});

function StopHarness() {
  const [reset, setReset] = useState(0);
  const control = useOperationControl(
    () => {},
    () => setReset((v) => v + 1),
  );
  return (
    <>
      <OperationControls control={control} />
      <output aria-label="初始化次数">{reset}</output>
    </>
  );
}
Object.assign(window, {
  renderStopHarness: () => root.render(<StopHarness />),
});
