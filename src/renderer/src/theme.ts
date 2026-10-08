const query = window.matchMedia('(prefers-color-scheme: dark)')

function apply(): void {
  document.documentElement.classList.toggle('dark', query.matches)
}

apply()
query.addEventListener('change', apply)
