const button = document.querySelector('#copyInstall');
const command = 'curl -fsSL https://welcome.ai.hehao.pro/install.sh | bash';
const domainInput = document.querySelector('#domainInput');
const domainField = document.querySelector('#domainField');
const domainCommand = document.querySelector('#domainCommand');
const copyDomainInstall = document.querySelector('#copyDomainInstall');
const installModeInputs = document.querySelectorAll('input[name="installMode"]');

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
  const mode = document.querySelector('input[name="installMode"]:checked')?.value || 'local';
  if (mode === 'public') return 'curl -fsSL https://welcome.ai.hehao.pro/install.sh | PUBLIC_BIND=1 bash';
  const domain = normalizedDomain(domainInput?.value);
  if (mode !== 'domain' || !domain || !domain.includes('.')) return command;
  return `curl -fsSL https://welcome.ai.hehao.pro/install.sh | DOMAIN=${domain} SETUP_CADDY=1 bash`;
}

function updateDomainCommand() {
  if (!domainCommand) return;
  const mode = document.querySelector('input[name="installMode"]:checked')?.value || 'local';
  if (domainField) domainField.hidden = mode !== 'domain';
  domainCommand.textContent = domainInstallCommand();
}

domainInput?.addEventListener('input', updateDomainCommand);
installModeInputs.forEach((input) => input.addEventListener('change', updateDomainCommand));
copyDomainInstall?.addEventListener('click', async () => {
  const text = domainInstallCommand();
  try {
    await navigator.clipboard.writeText(text);
    copyDomainInstall.textContent = '已复制';
    setTimeout(() => {
      copyDomainInstall.textContent = '复制部署命令';
    }, 1600);
  } catch {
    domainCommand.textContent = text;
  }
});
updateDomainCommand();

const revealTargets = document.querySelectorAll('.proof, .section-head, .case-item, .feature-list, .flow-lanes, .update-config, .install');

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
