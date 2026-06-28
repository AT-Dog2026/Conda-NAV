// 通用的对话框和文件操作工具

/**
 * 打开文件选择对话框
 * @param {object} options - { title, filters }
 * @returns {Promise<string|null>} 文件路径或 null
 */
export async function openFileDialog(options) {
  if (window.electron?.openFileDialog) {
    return window.electron.openFileDialog(options);
  }
  // 浏览器模式 fallback：使用 input[type=file]
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options?.filters?.length) {
      input.accept = options.filters.map(f => f.extensions.map(e => `.${e}`)).flat().join(',');
    }
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) {
        // 尝试获取完整路径（在 Electron 中可能不可用）
        resolve(file.path || file.name);
      } else {
        resolve(null);
      }
    };
    input.click();
  });
}

/**
 * 打开目录选择对话框
 */
export async function openDirectoryDialog(options) {
  if (window.electron?.openDirectoryDialog) {
    return window.electron.openDirectoryDialog(options);
  }
  return Promise.resolve(null);
}

/**
 * 打开保存文件对话框
 */
export async function saveFileDialog(options) {
  if (window.electron?.saveFileDialog) {
    return window.electron.saveFileDialog(options);
  }
  return Promise.resolve(null);
}
