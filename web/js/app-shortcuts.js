// 键盘快捷键 — 从 index.html 拆分后新增的交互层
//
// 设计取舍：这里不改动既有的按钮处理函数，而是通过 element.click() 复用它们。
// 好处是禁用态判断、忙碌标志、队列逻辑全部沿用一条路径，不会出现"快捷键绕过校验"
// 的经典缺陷（例如任务运行中再次按 Ctrl+Enter）。
//
// 冲突处理：Esc 在别处已被用于关闭图片弹层与视频放大视图，因此本模块在检测到
// 浮层打开时不抢 Esc，交给原来的处理函数。

(function () {
  const $ = (id) => document.getElementById(id);

  // 是否有浮层打开（有则让 Esc 归原来的关闭逻辑）
  function overlayOpen() {
    if (document.querySelector('.vd-zoom')) return true;          // 视频放大视图
    if (typeof imgModalOpen !== 'undefined' && imgModalOpen) return true; // 图片弹层
    return false;
  }

  // 主操作按钮此刻是否可用（禁用时说明有任务在跑）
  function clickable(el) {
    return el && !el.disabled;
  }

  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter：开始处理 / 加入队列
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const btn = $('startBtn');
      if (clickable(btn)) {
        e.preventDefault();
        btn.click();
      }
      return;
    }

    // Esc：停止当前任务（仅当确有任务在跑、且没有浮层占据 Esc 时）
    if (e.key === 'Escape' && !overlayOpen()) {
      const btn = $('cancelBtn');
      if (clickable(btn)) {
        e.preventDefault();
        btn.click();
      }
    }
  });

  // 首屏给一次可发现性提示：把快捷键写进页脚，而不是等用户去猜。
  window.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('header');
    if (!host || host.querySelector('.kbd-hint')) return;
    const hint = document.createElement('span');
    hint.className = 'sub kbd-hint';
    hint.style.marginLeft = 'auto';
    hint.innerHTML = '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 开始 · <kbd>Esc</kbd> 停止';
    host.appendChild(hint);
  });
})();
