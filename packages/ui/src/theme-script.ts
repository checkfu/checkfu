export const STORAGE_KEY = "theme"

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${STORAGE_KEY}")==="dark"?"dark":"light";document.documentElement.classList.add(t);document.documentElement.style.colorScheme=t}catch(e){}`
