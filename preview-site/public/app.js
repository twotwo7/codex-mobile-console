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

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  }
}, { threshold: 0.16 });

document.querySelectorAll('.workflow, .detail').forEach((node) => observer.observe(node));
