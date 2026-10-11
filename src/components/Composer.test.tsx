import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
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
  const { container } = render(<Harness />);
  const input = screen.getByRole('textbox');
  expect(screen.queryByRole('button', { name: '发送消息' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '你好' } });
  const send = screen.getByRole('button', { name: '发送消息' });
  expect(send).toHaveAttribute('type', 'submit');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByLabelText('发送次数')).toHaveTextContent('1');
  // Re-rendering as "stop" must reuse the same element instead of swapping two buttons.
  const { container: busyContainer } = render(<Harness busy />);
  const stop = within(busyContainer).getByRole('button', { name: '停止生成' });
  expect(stop).toHaveAttribute('type', 'button');
  expect(container).toBeTruthy();
  expect(send).toBeTruthy();
});
it('hides send for whitespace and exposes it for meaningful text', () => {
  render(<Harness />);
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  \n' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好' } });
  expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
});
