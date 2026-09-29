// 版本号的唯一来源是仓库根目录的 VERSION 文件（内容为裸版本号，不带 v 前缀）。
//
// 为什么单独做一个文件：版本号原本以字面量散落在 6 处（页面标题、页眉徽标、服务启动横幅、
// README 的两个包名、守护程序日志），而且**已经漂移过一次** —— 守护日志里的版本号一直
// 落后于其它位置。而守护源码是 UTF-16LE，普通文本搜索根本找不到它。
// （本注释刻意不写出具体的历史版本号：audit-version.js 要求代码文件里不出现任何版本字面量。）
//
// 现在只有 VERSION 是真源：
//   · 服务端在这里运行时读取（本文件）
//   · 页面通过 GET /api/info 取得并写入标题与页眉徽标
//   · 守护程序用的是 tools/sync-version.js 生成的 src/guard/version.h
//   · README 里的包名由同一个脚本改写
// tools/audit-version.js 会核对以上所有位置是否与 VERSION 一致。
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');

const VERSION_FILE = path.join(ROOT, 'VERSION');
const FALLBACK = '0.0-unknown';

function readRaw() {
    try {
        // VERSION 里存裸版本号；容忍有人手写成 v2.0-anyway
        const t = fs.readFileSync(VERSION_FILE, 'utf8').trim().replace(/^v/i, '');
        if (t) return t;
    } catch (e) { /* 文件缺失：退回到占位版本，不要因此让服务起不来 */ }
    return FALLBACK;
}

const raw = readRaw();

module.exports = {
    raw,                        // "2.0-anyway"
    display: 'v' + raw,         // "v2.0-anyway"（所有展示位置都用这个）
    file: VERSION_FILE,
    found: raw !== FALLBACK,    // 供启动横幅提示"VERSION 文件缺失"
};
