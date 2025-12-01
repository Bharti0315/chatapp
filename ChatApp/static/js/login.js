document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const empIdInput = document.getElementById('emp_id');
  const passwordInput = document.getElementById('password');
  const togglePasswordBtn = document.getElementById('togglePassword');
  const alertBox = document.getElementById('loginAlert');
  const loginBtn = document.getElementById('loginBtn');
  const year = document.getElementById('year');

  if (year) year.textContent = new Date().getFullYear();

  const MESSAGES = {
    missing: 'Please enter both Employee ID and Password',
    failed: 'Login failed',
  };

  function setLoading(loading) {
    if (!loginBtn) return;
    loginBtn.disabled = loading;
    const defaultText = loginBtn.querySelector('.default-text');
    const loadingText = loginBtn.querySelector('.loading-text');
    if (defaultText && loadingText) {
      defaultText.classList.toggle('d-none', loading);
      loadingText.classList.toggle('d-none', !loading);
    }
  }

  function showError(msg) {
    if (alertBox) {
      alertBox.textContent = msg || MESSAGES.failed;
      alertBox.classList.remove('d-none');
    }
  }

  function hideError() {
    if (alertBox) alertBox.classList.add('d-none');
  }

  // Password visibility toggle
  if (togglePasswordBtn && passwordInput) {
    togglePasswordBtn.addEventListener('click', () => {
      const isHidden = passwordInput.getAttribute('type') === 'password';
      passwordInput.setAttribute('type', isHidden ? 'text' : 'password');
      const icon = togglePasswordBtn.querySelector('i');
      if (icon) {
        icon.classList.toggle('fa-eye', !isHidden);
        icon.classList.toggle('fa-eye-slash', isHidden);
      }
      const pressed = togglePasswordBtn.getAttribute('aria-pressed') === 'true';
      togglePasswordBtn.setAttribute('aria-pressed', (!pressed).toString());
      togglePasswordBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  }

  // Live validation feedback
  if (empIdInput) {
    empIdInput.addEventListener('input', () => {
      empIdInput.classList.remove('is-invalid');
      hideError();
    });
  }

  if (passwordInput) {
    passwordInput.addEventListener('input', () => {
      passwordInput.classList.remove('is-invalid');
      hideError();
    });
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    // Normalize Employee ID formatting
    const emp_id = empIdInput?.value.trim().toUpperCase();
    const password = passwordInput?.value.trim();

    if (!emp_id || !password) {
      showError(MESSAGES.missing);
      if (!emp_id && empIdInput) empIdInput.classList.add('is-invalid');
      if (!password && passwordInput) passwordInput.classList.add('is-invalid');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emp_id, password })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data.error || MESSAGES.failed);

      window.location.href = '/';
    } catch (err) {
      showError(err.message || MESSAGES.failed);
    } finally {
      setLoading(false);
    }
  });
});
