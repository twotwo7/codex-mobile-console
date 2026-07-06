const button = document.querySelector('#copyInstall');
const command = 'curl -fsSL https://welcome.ai.hehao.pro/install.sh | bash';
const domainInput = document.querySelector('#domainInput');
const domainCommand = document.querySelector('#domainCommand');
const copyDomainInstall = document.querySelector('#copyDomainInstall');

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

function normalizedDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^-+|-+$/g, '');
}

function domainInstallCommand() {
  const domain = normalizedDomain(domainInput?.value);
  if (!domain || !domain.includes('.')) return command;
  return `curl -fsSL https://welcome.ai.hehao.pro/install.sh | DOMAIN=${domain} SETUP_CADDY=1 bash`;
}

function updateDomainCommand() {
  if (!domainCommand) return;
  domainCommand.textContent = domainInstallCommand();
}

domainInput?.addEventListener('input', updateDomainCommand);
copyDomainInstall?.addEventListener('click', async () => {
  const text = domainInstallCommand();
  try {
    await navigator.clipboard.writeText(text);
    copyDomainInstall.textContent = '已复制';
    setTimeout(() => {
      copyDomainInstall.textContent = '复制命令';
    }, 1600);
  } catch {
    domainCommand.textContent = text;
  }
});
updateDomainCommand();

const revealTargets = document.querySelectorAll('.proof, .section-head, .case-item, .feature-list, .flow-lanes, .update-config, .domain-builder, .install');

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
