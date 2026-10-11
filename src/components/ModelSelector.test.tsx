import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Composer } from './Composer';

it('opens the model menu with descriptions and no provider subscription items', () => {
  render(<Composer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy={false} />);
  fireEvent.keyDown(screen.getByRole('button', { name: '选择模型和努力程度' }), { key: 'Enter' });
  expect(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemradio', { name: /Fable 5.1/ })).toBeVisible();
  expect(screen.getByRole('menuitemradio', { name: /Opus 5.5/ })).toBeVisible();
  expect(screen.getByRole('menuitemradio', { name: /Haiku 5.5/ })).toBeVisible();
  expect(screen.queryByText('更多模型')).not.toBeInTheDocument();
  expect(screen.queryByText(/Pro|Max|升级|额度/)).not.toBeInTheDocument();
});
