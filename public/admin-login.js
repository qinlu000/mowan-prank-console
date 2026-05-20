const loginForm = document.querySelector("#loginForm");
const passwordInput = document.querySelector("#passwordInput");
const loginError = document.querySelector("#loginError");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;

  const password = passwordInput.value;
  if (!password) {
    loginError.textContent = "请输入后台密码";
    loginError.hidden = false;
    return;
  }

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "登录失败");
    }
    window.location.href = "/admin.html";
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  }
});
