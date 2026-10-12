import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { expect, it } from 'vitest';
import { Composer } from './Composer';
function Harness({ busy = false }: { busy?: boolean }) {
  const [value, setValue] = useState(''); const [sent, setSent] = useState(0);
  return <><Composer value={value} onChange={setValue} onSend={() => setSent(s => s + 1)} onStop={() => {}} busy={busy} /><output aria-label="发送次数">{sent}</output></>;
}
it('does not send blank or composing text but sends a later Enter', () => {
  render(<Harness />); const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter' }); expect(screen.getByLabelText('发送次数')).toHaveTextContent('0');
  fireEvent.change(input, { target: { value: '你好' } }); fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(screen.getByLabelText('发送次数')).toHaveTextContent('0');
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(screen.getByLabelText('发送次数')).toHaveTextContent('0');
  fireEvent.keyDown(input, { key: 'Enter' }); expect(screen.getByLabelText('发送次数')).toHaveTextContent('1');
});
it('blocks sending while generating and exposes stop', () => {
  render(<Harness busy />); fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好' } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(screen.getByLabelText('发送次数')).toHaveTextContent('0'); expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled();
});
it('retains the Sonnet 5.5 and effort labels without unimplemented mode or service controls', () => {
  render(<Harness />);
  expect(screen.getByText('Sonnet 5.5')).toBeVisible();
  expect(screen.getByText('中等')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Cowork' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择模型和努力程度' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '添加内容' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '语音输入' })).not.toBeInTheDocument();
});
it('keeps one stable send/stop button so a single click cannot do both', () => {
  function SwitchingHarness() {
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(0);
    const [stopped, setStopped] = useState(0);
    return <><Composer value="你好" onChange={() => {}} busy={busy} onSend={() => flushSync(() => { setSent(n => n + 1); setBusy(true); })} onStop={() => flushSync(() => { setStopped(n => n + 1); setBusy(false); })} /><output aria-label="发送次数">{sent}</output><output aria-label="停止次数">{stopped}</output></>;
  }
  render(<SwitchingHarness />);
  const input = screen.getByRole('textbox');
  const send = screen.getByRole('button', { name: '发送消息' });
  fireEvent.click(send);
  expect(screen.getByLabelText('发送次数')).toHaveTextContent('1');
  const stop = screen.getByRole('button', { name: '停止生成' });
  expect(stop).toBe(send);
  fireEvent.click(stop);
  expect(screen.getByLabelText('停止次数')).toHaveTextContent('1');
  expect(screen.getByLabelText('发送次数')).toHaveTextContent('1');
  expect(screen.getByRole('button', { name: '发送消息' })).toBe(send);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByLabelText('发送次数')).toHaveTextContent('2');
});
it('hides send for whitespace and exposes it for meaningful text', () => {
  render(<Harness />);
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  \n' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});

it('keeps the send/stop element mounted but inaccessible for an empty home composer', () => {
  const { container, rerender } = render(<Composer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy={false} home />);
  const button = container.querySelector('.send-button');
  expect(button).toHaveAttribute('hidden');
  expect(screen.queryByRole('button', { name: '发送消息' })).not.toBeInTheDocument();
  rerender(<Composer value="问题" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy={false} home />);
  expect(screen.getByRole('button', { name: '发送消息' })).toBe(button);
  rerender(<Composer value="问题" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy home />);
  expect(screen.getByRole('button', { name: '停止生成' })).toBe(button);
});
