// 内置评论后端（Twikoo 协议兼容）。
//
// 前端 src/lib/comments.js 本来就以 Twikoo 事件协议（COMMENT_GET / COMMENT_SUBMIT /
// COMMENT_LIKE）请求评论接口——这里实现同一协议，评论落在 data/comments.json，
// 从而能在博客自己的后台「评论管理」里自由管理（先显后审：评论提交后立即可见，
// 事后可隐藏 / 删除）。若配置了 PUBLIC_TWIKOO_ENV_ID，前端仍可直连外部 Twikoo。
import crypto from 'node:crypto';
import { marked } from 'marked';
import { readJSON, updateJSON, newId } from './store.mjs';

const COMMENTS_FILE = 'comments.json';
const EMPTY = [];

const loadAll = () => {
  const list = readJSON(COMMENTS_FILE, EMPTY);
  return Array.isArray(list) ? list : [];
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]),
  );

// 邮箱 → Gravatar/Cravatar 用的 md5（与前端 avatar() 约定一致）。
export const mailMd5Of = (mail) =>
  crypto.createHash('md5').update(String(mail || '').trim().toLowerCase()).digest('hex');

// 评论正文：先把原文整体转义（杜绝访客注入原始 HTML），再交给 marked 渲染
// Markdown，最后对生成的链接/图片地址做协议白名单校验。前端展示时还有
// DOM 白名单净化兜底（src/lib/comments.js 的 sanitizeComment）。
function renderCommentHtml(markdown) {
  const source = esc(String(markdown ?? '')).slice(0, 20000);
  let html = String(marked.parse(source, { async: false, gfm: true, breaks: true }));
  html = html.replace(/(href|src)="([^"]*)"/gi, (match, attr, value) => {
    const v = String(value).trim().toLowerCase();
    const ok =
      v.startsWith('http://') || v.startsWith('https://') || (attr === 'href' && v.startsWith('mailto:'));
    return ok ? match : `${attr}="#"`;
  });
  return html;
}

const trimLen = (v, max) => String(v ?? '').trim().slice(0, max);

// 对外暴露的单条评论结构（对齐 Twikoo 字段命名）。
function publicComment(c) {
  return {
    id: c.id,
    nick: c.nick,
    mailMd5: c.mailMd5,
    link: c.link || '',
    comment: c.comment,
    created: c.created,
    like: c.like || 0,
    master: Boolean(c.master),
    ruser: c.ruser || '',
    pid: c.pid || '',
    rid: c.rid || '',
  };
}

// —— Twikoo 协议：COMMENT_GET ——
// 返回某页面的评论树：顶层评论 + 各自的二级回复（时间正序）。
export function getComments({ url, page = 1, pageSize = 20 }) {
  const target = trimLen(url, 300);
  const all = loadAll().filter((c) => c.url === target && c.status === 'visible');

  const tops = all
    .filter((c) => !c.pid)
    .sort((a, b) => b.created - a.created);
  const count = tops.length;

  const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const pageNo = Math.max(1, Number(page) || 1);
  const slice = tops.slice((pageNo - 1) * size, pageNo * size);

  const byId = new Map(all.map((c) => [c.id, c]));
  const data = slice.map((top) => {
    const replies = all
      .filter((c) => c.pid === top.id)
      .sort((a, b) => a.created - b.created)
      .map((c) => ({
        ...publicComment(c),
        // 二级回复里带上被回复者昵称（前端显示「回复 XX」）。
        ruser: c.rid && byId.get(c.rid) ? byId.get(c.rid).nick : c.ruser || '',
      }));
    return { ...publicComment(top), replies };
  });

  return { data, count };
}

// —— Twikoo 协议：COMMENT_SUBMIT ——
// 先显后审：新评论立即以 visible 状态落库并展示，管理员事后可隐藏 / 删除。
// 读-改-写在 updateJSON 的文件级互斥内完成，高并发提交不丢评论。
export async function submitComment({ url, nick, mail, link, comment, ua, pid, rid, ipHash: hash, master = false }) {
  const target = trimLen(url, 300);
  const text = String(comment ?? '').trim();
  const name = trimLen(nick, 32);
  if (!target.startsWith('/')) throw new Error('页面路径无效');
  if (!name) throw new Error('请填写昵称');
  if (!text) throw new Error('评论内容不能为空');
  if (text.length > 5000) throw new Error('评论内容过长');

  return updateJSON(COMMENTS_FILE, EMPTY, (all) => {
    // 二级回复：pid 指向顶层评论；rid 指向被回复的那条评论。
    let parentPid = '';
    let replyToId = '';
    let ruser = '';
    if (pid) {
      const parent = all.find((c) => c.id === pid && c.url === target);
      if (!parent) throw new Error('回复的评论不存在');
      parentPid = parent.pid || parent.id;
      if (rid) {
        const targetComment = all.find((c) => c.id === rid && c.url === target);
        if (targetComment) {
          replyToId = targetComment.id;
          ruser = targetComment.nick;
        }
      }
      if (!replyToId) {
        replyToId = parent.id;
        ruser = parent.nick;
      }
    }

    const entry = {
      id: newId(),
      url: target,
      nick: name,
      mail: trimLen(mail, 100),
      mailMd5: mailMd5Of(mail),
      link: trimLen(link, 200),
      comment: renderCommentHtml(text),
      commentMd: text.slice(0, 5000),
      ua: trimLen(ua, 200),
      ipHash: String(hash || ''),
      created: Date.now(),
      pid: parentPid,
      rid: replyToId,
      ruser,
      like: 0,
      likedBy: [],
      status: 'visible',
      master: Boolean(master),
    };

    all.push(entry);
    return { id: entry.id, code: 0 };
  });
}

// —— Twikoo 协议：COMMENT_LIKE ——
// 按 IP 哈希去重，同一访客对同一条评论只计一次赞；计数在互斥锁内自增。
export async function likeComment({ id, ipHash: hash }) {
  return updateJSON(COMMENTS_FILE, EMPTY, (all) => {
    const c = all.find((item) => item.id === id);
    if (!c) throw new Error('评论不存在');
    const key = String(hash || '');
    c.likedBy = Array.isArray(c.likedBy) ? c.likedBy : [];
    if (key && c.likedBy.includes(key)) return { code: 0, like: c.like || 0 };
    if (key) {
      c.likedBy.push(key);
      if (c.likedBy.length > 2000) c.likedBy = c.likedBy.slice(-2000);
    }
    c.like = (c.like || 0) + 1;
    return { code: 0, like: c.like };
  });
}

// —— 后台管理 ——
export function adminList({ status, keyword } = {}) {
  let list = loadAll().sort((a, b) => b.created - a.created);
  if (status && status !== 'all') list = list.filter((c) => c.status === status);
  const kw = trimLen(keyword, 60).toLowerCase();
  if (kw) {
    list = list.filter(
      (c) =>
        c.nick.toLowerCase().includes(kw) ||
        c.url.toLowerCase().includes(kw) ||
        String(c.commentMd || '').toLowerCase().includes(kw),
    );
  }
  return list.map((c) => ({
    ...publicComment(c),
    commentMd: c.commentMd || '',
    mail: c.mail || '',
    ua: c.ua || '',
    status: c.status,
  }));
}

export function adminSetStatus(id, status) {
  if (!['visible', 'hidden'].includes(status)) throw new Error('状态无效');
  return updateJSON(COMMENTS_FILE, EMPTY, (all) => {
    const c = all.find((item) => item.id === id);
    if (!c) throw new Error('评论不存在');
    c.status = status;
    return { ok: true };
  });
}

export function adminRemove(id) {
  return updateJSON(COMMENTS_FILE, EMPTY, (all) => {
    const next = all.filter((c) => c.id !== id && c.pid !== id);
    if (next.length === all.length) throw new Error('评论不存在');
    all.length = 0;
    all.push(...next);
    return { ok: true };
  });
}

// 博主回复：直接以 master 身份补一条顶层或楼中楼评论。
export async function adminReply({ id, comment, nick, ipHash: hash }) {
  const parent = loadAll().find((c) => c.id === id);
  if (!parent) throw new Error('评论不存在');
  return submitComment({
    url: parent.url,
    nick: nick || '博主',
    mail: parent.mail,
    link: '',
    comment,
    ua: 'admin-panel',
    pid: parent.pid || parent.id,
    rid: parent.id,
    ipHash: hash,
    master: true,
  });
}

export function adminCount() {
  const all = loadAll();
  return {
    total: all.length,
    visible: all.filter((c) => c.status === 'visible').length,
    hidden: all.filter((c) => c.status === 'hidden').length,
  };
}
