const copyLinks = document.querySelectorAll('[data-copy]');

for (const link of copyLinks) {
  link.addEventListener('click', async (event) => {
    const value = link.dataset.copy;
    if (!value) return;
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      const original = link.textContent;
      link.textContent = '已复制';
      window.setTimeout(() => { link.textContent = original; }, 1400);
    } catch {
      window.location.href = link.href;
    }
  });
}
