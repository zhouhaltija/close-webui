// Synthetic layout fixtures only; never copy titles from personal accounts.
export const referenceHistory = Array.from({ length: 22 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  const title = index % 4 === 0
    ? `界面验收样例 ${number}：用于检查长标题截断与列表布局的虚构对话`
    : `界面验收样例 ${number}`;
  const date = new Date(Date.UTC(2026, 9, 9, 12, 0, -index)).toISOString();
  return { id: `reference-${index}`, title, createdAt: date, updatedAt: date, messages: [] };
});
