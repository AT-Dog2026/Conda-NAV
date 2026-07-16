const settings = require('./settings');

let currentActivatedEnv = null;

// 启动时从持久化设置恢复激活环境
function init() {
  currentActivatedEnv = settings.getActivatedEnv();
}

function getActivatedEnv() {
  return currentActivatedEnv;
}

function setActivatedEnv(name) {
  currentActivatedEnv = name;
  // 持久化到设置文件
  settings.setActivatedEnv(name);
}

module.exports = { init, getActivatedEnv, setActivatedEnv };

