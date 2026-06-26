const button = document.querySelector('#copyInstall');
const command = 'curl -fsSL https://raw.githubusercontent.com/twotwo7/codex-mobile-console/main/scripts/install.sh | bash';

button?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(command);
    button.textContent = '已复制';
    setTimeout(() => {
      button.textContent = '复制安装命令';
    }, 1600);
  } catch {
    button.textContent = command;
  }
});

const revealTargets = document.querySelectorAll('.proof, .section-head, .case-item, .feature-list, .install');

if ('IntersectionObserver' in window) {
  revealTargets.forEach((node) => node.classList.add('reveal'));

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });

  revealTargets.forEach((node) => observer.observe(node));
} else {
  revealTargets.forEach((node) => node.classList.add('visible'));
}
