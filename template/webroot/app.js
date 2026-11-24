"use strict";

const stateDir = "/data/adb/omk";
const configDir = "/data/misc/keystore/omk";
const moduleDir = "/data/adb/modules/oh_my_keymint";
const refresh = document.querySelector("#refresh");
const summary = document.querySelector("#summary");
const notice = document.querySelector("#notice");
const confirm = document.querySelector("#confirm");
const actions = [...document.querySelectorAll("[data-restart]")];
const restartLabels = { keymint: "KeyMint", injector: "Injector", all: "全部服务" };
let restartTarget;
let callbackId = 0;

function exec(command) {
  return new Promise((resolve, reject) => {
    const callback = `omkCallback_${Date.now()}_${callbackId++}`;
    const timeout = setTimeout(() => {
      delete window[callback];
      reject(new Error("KernelSU bridge timeout"));
    }, 6000);

    window[callback] = (code, output) => {
      clearTimeout(timeout);
      delete window[callback];
      if (Number(code) === 0) resolve(output);
      else reject(new Error("KernelSU command failed"));
    };

    try {
      window.ksu.exec(command, "{}", callback);
    } catch (error) {
      clearTimeout(timeout);
      delete window[callback];
      reject(error);
    }
  });
}

function daemonCheck(name, script) {
  return `pid=$(cat '${stateDir}/${name}-daemon.pid' 2>/dev/null)
case "$pid" in
  ''|*[!0-9]*) printf '0\n' ;;
  *) if tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fxq '${moduleDir}/${script}'; then
       printf '1\n'
     else
       printf '0\n'
     fi ;;
esac`;
}

function renderChip(id, value, yes, no) {
  const chip = document.getElementById(id);
  chip.textContent = value === null ? "—" : value ? yes : no;
  chip.dataset.ok = String(value === true);
}

async function loadStatus() {
  let state = [null, null, null, null];
  refresh.disabled = true;
  actions.forEach(button => { button.disabled = true; });
  try {
    if (typeof window.ksu?.exec !== "function") {
      summary.textContent = "请从 KernelSU 模块列表打开";
      return;
    }

    const output = await exec(`${daemonCheck("keymint", "daemon")}
${daemonCheck("injector", "daemon-injector")}
for file in config.toml injector.toml; do
  if [ -f '${configDir}'/"$file" ]; then printf '1\n'; else printf '0\n'; fi
done`);
    const values = output.trim().split(/\s+/);
    if (values.length !== 4 || values.some(value => !/^[01]$/.test(value))) {
      throw new Error("Unexpected status output");
    }

    state = values.map(value => value === "1");
    const [keymint, injector] = state;
    summary.textContent = keymint && injector ? "两个守护进程均在运行" :
      keymint || injector ? "部分守护进程未运行" : "守护进程未运行";
    actions.forEach(button => {
      const target = button.dataset.restart;
      button.disabled = target === "keymint" ? !keymint :
        target === "injector" ? !injector : !(keymint && injector);
    });
  } catch {
    summary.textContent = "读取状态失败，请刷新重试";
  } finally {
    renderChip("keymint", state[0], "运行中", "未运行");
    renderChip("injector", state[1], "运行中", "未运行");
    renderChip("config", state[2], "已找到", "未找到");
    renderChip("settings", state[3], "已找到", "未找到");
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", loadStatus);
actions.forEach(button => {
  button.addEventListener("click", () => {
    restartTarget = button.dataset.restart;
    confirm.returnValue = "";
    document.querySelector("#confirm-title").textContent = `重启 ${restartLabels[restartTarget]}？`;
    confirm.showModal();
  });
});

confirm.addEventListener("close", async () => {
  if (confirm.returnValue !== "restart" || !Object.hasOwn(restartLabels, restartTarget)) return;
  refresh.disabled = true;
  actions.forEach(button => { button.disabled = true; });
  notice.hidden = true;
  try {
    await exec(`touch '${stateDir}/restart.${restartTarget}'`);
    notice.textContent = "已提交重启请求。";
  } catch {
    notice.textContent = "提交重启请求失败。";
  } finally {
    notice.hidden = false;
    await loadStatus();
  }
});

loadStatus();
