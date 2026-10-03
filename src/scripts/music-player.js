// 音乐播放器运行逻辑（自 MusicPlayer.astro 外置，行为不变）。
// 打包为可缓存模块；播放器 DOM 带 transition:persist 换页复用同一节点，
// 整个脚本只在首次加载初始化一次。歌单 ID 由组件 data 属性注入，
// 未配置（或为占位符）时组件整体不渲染，脚本自然不初始化。
// 外部 Meting 解析请求统一走 ./music-api.js（含出站地址校验）；
// 歌词 LRC 解析走 ./../lib/lrc.js（纯函数，单测覆盖）。
import { fetchMetingPlaylist } from './music-api.js';
import { gatewayUrl } from '../lib/gateway.js';
import { parseLrc } from '../lib/lrc.js';

(() => {
  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  };

  // [0,1) 均匀随机数：随机播放使用 Web Crypto，避免弱随机数告警。
  const secureRandom = () => {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return buf[0] / 2 ** 32;
  };

  const initPlayer = (root) => {
    if (root.dataset.ready === 'true') return;
    root.dataset.ready = 'true';

    const panel = root.querySelector('[data-music-panel]');
    const toggle = root.querySelector('[data-music-toggle]');
    const closeButton = root.querySelector('[data-music-close]');
    const audio = root.querySelector('[data-music-audio]');
    const playButton = root.querySelector('[data-music-play]');
    const prevButton = root.querySelector('[data-music-prev]');
    const nextButton = root.querySelector('[data-music-next]');
    const muteButton = root.querySelector('[data-music-mute]');
    const shuffleButton = root.querySelector('[data-music-shuffle]');
    const repeatButton = root.querySelector('[data-music-repeat]');
    const favoriteButton = root.querySelector('[data-music-favorite]');
    const retryButton = root.querySelector('[data-music-retry]');
    const progress = root.querySelector('[data-music-progress]');
    const currentTime = root.querySelector('[data-music-current-time]');
    const duration = root.querySelector('[data-music-duration]');
    const title = root.querySelector('[data-music-title]');
    const artist = root.querySelector('[data-music-artist]');
    const status = root.querySelector('[data-music-status]');
    const count = root.querySelector('[data-music-count]');
    const list = root.querySelector('[data-music-list]');
    const cover = root.querySelector('[data-music-cover]');
    const dockCover = root.querySelector('[data-music-dock-cover]');
    const lyricsBox = root.querySelector('[data-music-lyrics]');
    const lyricToggle = root.querySelector('[data-music-lyric-toggle]');
    // 未配置歌单 ID 时直接不初始化播放器，而不是回落到写死的真实歌单
    const playlistId = root.dataset.playlistId || '';
    const storageKey = `blog-music-player:${playlistId}`;

    if (
      !playlistId ||
      !panel || !toggle || !audio || !playButton || !prevButton || !nextButton ||
      !muteButton || !progress || !list || !title || !artist || !status
    ) return;

    let tracks = [];
    let currentIndex = 0;
    let loadedIndex = -1;
    let wantsPlayback = false;
    let playGeneration = 0;
    let skipScheduled = false;
    let skipTimer = 0;
    let failedTracks = new Set();
    let fetchController = null;
    // 歌词状态：当前解析出的行、已高亮行号、加载代次（防切歌竞态）。
    let lyrics = [];
    let lyricIndex = -1;
    let lyricGeneration = 0;
    const lyricCache = new Map(); // neteaseId -> LRC 文本

    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem(storageKey) || '{}');
      } catch {
        return {};
      }
    })();

    let shuffleEnabled = Boolean(saved.shuffle);
    let repeatOne = Boolean(saved.repeatOne);
    let lyricsVisible = saved.showLyrics !== false;
    const favorites = new Set(
      Array.isArray(saved.favorites)
        ? saved.favorites.filter((value) => typeof value === 'string').slice(0, 250)
        : [],
    );

    audio.volume = Number.isFinite(saved.volume)
      ? Math.min(1, Math.max(0, saved.volume))
      : 0.72;
    audio.muted = Boolean(saved.muted);
    audio.loop = repeatOne;
    root.classList.toggle('is-muted', audio.muted);
    shuffleButton?.setAttribute('aria-pressed', String(shuffleEnabled));
    repeatButton?.setAttribute('aria-pressed', String(repeatOne));

    const persist = () => {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            index: currentIndex,
            volume: audio.volume,
            muted: audio.muted,
            shuffle: shuffleEnabled,
            repeatOne,
            showLyrics: lyricsVisible,
            favorites: [...favorites],
          }),
        );
      } catch {
      }
    };

    const safeUrl = (value) => {
      if (!value) return '';
      try {
        const parsed = new URL(String(value), window.location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
          parsed.protocol = 'https:';
        }
        return parsed.toString();
      } catch {
        return '';
      }
    };

    const cleanText = (value, fallback) => {
      const text = String(value || '').trim().replace(/\s+/g, ' ');
      return (text || fallback).slice(0, 180);
    };

    const setStatus = (message) => {
      status.textContent = message;
    };

    const setControlsDisabled = (disabled) => {
      [
        playButton,
        prevButton,
        nextButton,
        muteButton,
        shuffleButton,
        repeatButton,
        favoriteButton,
      ].forEach((button) => {
        if (!button) return;
        button.disabled = disabled;
      });
    };

    const setOpen = (open) => {
      root.classList.toggle('is-open', open);
      panel.setAttribute('aria-hidden', String(!open));
      if (open) panel.removeAttribute('inert');
      else panel.setAttribute('inert', '');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '收起音乐播放器' : '打开音乐播放器');
      toggle.title = open ? '收起音乐' : '音乐';
      if (open) {
        window.requestAnimationFrame(() => {
          scrollActiveTrack();
          closeButton?.focus({ preventScroll: true });
        });
      }
    };

    const updateCover = (image, source) => {
      if (!image) return;
      if (!source) {
        image.hidden = true;
        image.removeAttribute('src');
        return;
      }
      image.hidden = false;
      image.src = source;
    };

    cover?.addEventListener('error', () => { cover.hidden = true; });
    dockCover?.addEventListener('error', () => { dockCover.hidden = true; });

    const updateMediaSession = (track) => {
      if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: 'L1angK1NG的博客 · 网易云歌单',
          artwork: track.cover
            ? [{ src: track.cover, sizes: '300x300', type: 'image/jpeg' }]
            : [],
        });
      } catch {
      }
    };

    const getTrackKey = (track) => `${track.title} ${track.artist} ${track.url}`;

    const updateFavoriteState = () => {
      if (!favoriteButton || !tracks.length) return;
      const active = favorites.has(getTrackKey(tracks[currentIndex]));
      favoriteButton.classList.toggle('is-favorite', active);
      favoriteButton.setAttribute('aria-pressed', String(active));
      favoriteButton.setAttribute('aria-label', active ? '取消收藏当前歌曲' : '收藏当前歌曲');
      favoriteButton.title = active ? '取消收藏' : '收藏';
    };

    const scrollActiveTrack = () => {
      const activeButton = list.querySelector(`[data-track-index="${currentIndex}"]`);
      activeButton?.scrollIntoView({ block: 'nearest' });
    };

    const updateActiveTrack = () => {
      list.querySelectorAll('[data-track-index]').forEach((button) => {
        const active = Number(button.dataset.trackIndex) === currentIndex;
        button.setAttribute('aria-current', String(active));
      });
    };

    // —— 歌词 ——
    const applyLyricsVisibility = () => {
      if (lyricsBox) lyricsBox.hidden = !lyricsVisible;
      if (lyricToggle) {
        lyricToggle.setAttribute('aria-pressed', String(lyricsVisible));
        lyricToggle.setAttribute('aria-label', lyricsVisible ? '隐藏歌词' : '显示歌词');
        lyricToggle.title = lyricsVisible ? '隐藏歌词' : '歌词';
      }
    };

    const setLyricPlaceholder = (text) => {
      lyrics = [];
      lyricIndex = -1;
      if (!lyricsBox) return;
      lyricsBox.replaceChildren();
      const p = document.createElement('p');
      p.className = 'music-player__lyric-line is-placeholder';
      p.textContent = text;
      lyricsBox.append(p);
    };

    const renderLyrics = () => {
      if (!lyricsBox) return;
      lyricsBox.replaceChildren();
      const fragment = document.createDocumentFragment();
      lyrics.forEach((line) => {
        const p = document.createElement('p');
        p.className = 'music-player__lyric-line';
        p.dataset.musicLyricLine = '';
        p.textContent = line.text || '·';
        fragment.append(p);
      });
      lyricsBox.append(fragment);
    };

    // 拉取并解析歌词（经后端转发）。切歌可能连续触发，用代次号丢弃过期结果。
    const loadLyricsFor = async (index) => {
      const generation = ++lyricGeneration;
      const track = tracks[index];
      if (!track) return;
      if (!track.neteaseId) {
        setLyricPlaceholder('暂无歌词');
        return;
      }
      const cached = lyricCache.get(track.neteaseId);
      if (cached !== undefined) {
        lyrics = parseLrc(cached);
        lyricIndex = -1;
        if (lyrics.length) renderLyrics();
        else setLyricPlaceholder('暂无歌词');
        return;
      }
      setLyricPlaceholder('歌词加载中…');
      let text = '';
      try {
        const path = `/api/public/playlist/lyric/${track.neteaseId}`;
        const request = window.__blogApi?.gateFetch
          ? window.__blogApi.gateFetch(path, { headers: { Accept: 'application/json' } })
          : fetch(gatewayUrl(path), { headers: { Accept: 'application/json' } });
        const res = await request;
        if (res && res.ok) text = String((await res.json())?.lyric ?? '');
      } catch {
        /* 拿不到歌词按无歌词处理 */
      }
      lyricCache.set(track.neteaseId, text);
      if (generation !== lyricGeneration) return;
      lyrics = parseLrc(text);
      lyricIndex = -1;
      if (lyrics.length) renderLyrics();
      else setLyricPlaceholder('暂无歌词');
    };

    // 播放进度驱动歌词高亮与滚动。
    const updateLyricHighlight = (time) => {
      if (!lyrics.length || !lyricsBox) return;
      let idx = -1;
      for (let i = 0; i < lyrics.length; i += 1) {
        if (lyrics[i].time <= time + 0.05) idx = i;
        else break;
      }
      if (idx === lyricIndex) return;
      lyricIndex = idx;
      const items = lyricsBox.querySelectorAll('[data-music-lyric-line]');
      items.forEach((el, i) => el.classList.toggle('is-active', i === idx));
      items[idx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const showTrack = (index) => {
      if (!tracks.length) return;
      currentIndex = ((index % tracks.length) + tracks.length) % tracks.length;
      const track = tracks[currentIndex];
      title.textContent = track.title;
      artist.textContent = track.artist;
      updateCover(cover, track.cover);
      updateCover(dockCover, track.cover);
      updateActiveTrack();
      updateFavoriteState();
      if (count) count.textContent = `${currentIndex + 1}/${tracks.length}`;
      if (root.classList.contains('is-open')) window.requestAnimationFrame(scrollActiveTrack);
      updateMediaSession(track);
      loadLyricsFor(currentIndex);
      persist();
    };

    const resetTimeline = () => {
      progress.value = '0';
      progress.style.setProperty('--music-progress', '0%');
      progress.parentElement?.style.setProperty('--music-progress', '0%');
      progress.disabled = true;
      progress.setAttribute('aria-valuetext', '0:00 / 0:00');
      if (currentTime) currentTime.textContent = '0:00';
      if (duration) duration.textContent = '0:00';
    };

    const loadCurrentAudio = () => {
      if (!tracks.length) return false;
      if (loadedIndex === currentIndex && audio.src) return true;
      loadedIndex = currentIndex;
      resetTimeline();
      audio.src = tracks[currentIndex].url;
      audio.load();
      return true;
    };

    // 网易云曲目首次播放或播放出错时，懒解析出可用地址再播。
    // 解析成功会回写 track.url，同曲目复用；失败则走既有的跳过逻辑。
    const ensureTrackUrl = async () => {
      const track = tracks[currentIndex];
      if (!track) return false;
      if (track.url) return true;
      const fresh = await resolveNeteaseUrl(track);
      if (!fresh) return false;
      track.url = fresh;
      loadedIndex = -1;
      return true;
    };

    const scheduleSkip = () => {
      if (skipScheduled || !wantsPlayback || !tracks.length) return;
      skipScheduled = true;
      failedTracks.add(currentIndex);
      root.classList.remove('is-playing', 'is-loading');

      if (failedTracks.size >= tracks.length) {
        wantsPlayback = false;
        setStatus('歌单中的曲目暂时都无法播放');
        skipScheduled = false;
        return;
      }

      let next = currentIndex;
      do {
        next = (next + 1) % tracks.length;
      } while (failedTracks.has(next) && next !== currentIndex);

      setStatus('这首暂不可播，已为你切换下一首');
      skipTimer = window.setTimeout(() => {
        skipTimer = 0;
        skipScheduled = false;
        selectTrack(next, true, false);
      }, 420);
    };

    // 像音频直链的地址（带音频扩展名，可能带查询串）。
    const looksLikeDirectAudio = (u) => /\.(mp3|m4a|flac|aac|ogg|wav)(\?|$)/i.test(String(u || ''));

    const playCurrent = async () => {
      // 无直链的网易云曲目先懒解析（服务端返回 CDN 直链）；解析失败按不可播处理。
      if (!tracks[currentIndex]?.url) {
        const ok = await ensureTrackUrl();
        if (!ok) {
          scheduleSkip();
          return;
        }
      }
      if (!loadCurrentAudio()) return;
      const generation = ++playGeneration;
      wantsPlayback = true;
      root.classList.add('is-loading');
      setStatus('正在缓冲…');
      try {
        await audio.play();
      } catch (error) {
        if (generation !== playGeneration || error?.name === 'AbortError') return;
        root.classList.remove('is-loading');
        if (error?.name === 'NotAllowedError') {
          wantsPlayback = false;
          setStatus('浏览器阻止了播放，请再点一次');
          return;
        }
        scheduleSkip();
      }
    };

    function selectTrack(index, shouldPlay, userInitiated = true) {
      if (!tracks.length) return;
      if (userInitiated && skipTimer) {
        window.clearTimeout(skipTimer);
        skipTimer = 0;
        skipScheduled = false;
      }
      if (userInitiated) failedTracks.delete(((index % tracks.length) + tracks.length) % tracks.length);
      const changed = currentIndex !== ((index % tracks.length) + tracks.length) % tracks.length;
      if (changed) {
        playGeneration += 1;
        if (!audio.paused) audio.pause();
      }
      showTrack(index);
      if (changed) {
        loadedIndex = -1;
        audio.removeAttribute('src');
        audio.load();
        resetTimeline();
      }
      if (shouldPlay) playCurrent();
      else setStatus('准备就绪');
    }

    const getAdjacentIndex = (direction) => {
      if (!shuffleEnabled || tracks.length < 2) return currentIndex + direction;
      let candidate = currentIndex;
      for (let attempts = 0; attempts < tracks.length * 2 && candidate === currentIndex; attempts += 1) {
        candidate = Math.floor(secureRandom() * tracks.length);
      }
      return candidate === currentIndex ? currentIndex + direction : candidate;
    };

    const renderTracks = () => {
      list.replaceChildren();
      const fragment = document.createDocumentFragment();
      tracks.forEach((track, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        const artwork = track.cover
          ? document.createElement('img')
          : document.createElement('span');
        const copy = document.createElement('span');
        const trackTitle = document.createElement('strong');
        const trackArtist = document.createElement('small');
        const trackPosition = document.createElement('span');

        button.type = 'button';
        button.className = 'music-player__track-button';
        button.dataset.trackIndex = String(index);
        button.setAttribute('aria-label', `播放 ${track.title} - ${track.artist}`);
        button.setAttribute('aria-current', String(index === currentIndex));
        if (artwork instanceof HTMLImageElement) {
          artwork.className = 'music-player__track-art';
          artwork.src = track.cover;
          artwork.alt = '';
          artwork.loading = 'lazy';
          artwork.referrerPolicy = 'no-referrer';
        } else {
          artwork.className = 'music-player__track-number';
          artwork.textContent = String(index + 1).padStart(2, '0');
        }
        copy.className = 'music-player__track-copy';
        trackTitle.textContent = track.title;
        trackArtist.textContent = track.artist;
        trackPosition.className = 'music-player__track-position';
        trackPosition.textContent = String(index + 1).padStart(2, '0');
        copy.append(trackTitle, trackArtist);
        button.append(artwork, copy, trackPosition);
        item.append(button);
        fragment.append(item);
      });
      list.append(fragment);
    };

    const loadPlaylist = async () => {
      fetchController?.abort();
      fetchController = new AbortController();
      const timeout = window.setTimeout(() => fetchController.abort(), 10000);
      setControlsDisabled(true);
      retryButton?.setAttribute('hidden', '');
      count.textContent = '加载中';
      setStatus('正在连接歌单…');
      list.innerHTML = '<li class="music-player__empty">正在读取歌单…</li>';

      // 统一的曲目映射：兼容自建歌单接口与 Meting 接口的字段命名。
      // Meting 歌单条目常不带 id，从其 url（type=url&id=…）里提取，
      // 播放地址失效时仍可按 neteaseId 重新解析。
      const extractIdFromUrl = (value) => {
        const m = String(value || '').match(/[?&](?:id|songid)=(\d{4,})/i);
        return m ? m[1] : '';
      };
      const toTrack = (item, index) => {
        const rawUrl = safeUrl(item.url ?? item.src);
        const neteaseId =
          String(item.neteaseId ?? item.id ?? '') ||
          extractIdFromUrl(item.url ?? item.src ?? item.lrc);
        return {
          title: cleanText(item.title ?? item.name, '未知歌曲'),
          artist: cleanText(item.author ?? item.artist, '未知歌手'),
          cover: safeUrl(item.pic ?? item.cover ?? item.image),
          // 302 跳板链接不能直接作 <audio> 地址（加载会失败）：有 ID 的曲目
          // 留空走懒解析（后端返回 CDN 直链），无 ID 时才保留原链接兜底。
          url: rawUrl && looksLikeDirectAudio(rawUrl) ? rawUrl : neteaseId ? '' : rawUrl,
          neteaseId,
          source: item.source === 'local' ? 'local' : item.source === 'netease' ? 'netease' : '',
          index,
        };
      };

      try {
        // 优先读博客自建歌单（后台「音乐」模块维护：本地上传 + 网易云导入）。
        let items = [];
        let managed = false;
        // 本地 API 走哨兵门控：无后端时跳过请求，直接回退到网易云歌单。
        try {
          const request = window.__blogApi?.gateFetch
            ? window.__blogApi.gateFetch('/api/public/playlist', {
                signal: fetchController.signal,
                headers: { Accept: 'application/json' },
              })
            : fetch('/api/public/playlist', {
                signal: fetchController.signal,
                headers: { Accept: 'application/json' },
              });
          const res = await request;
          if (res && res.ok) {
            const data = await res.json();
            if (Array.isArray(data?.tracks) && data.tracks.length) {
              items = data.tracks;
              managed = true;
            }
          }
        } catch {
          // 自建歌单不可用时回退到网易云歌单。
        }

        if (!managed) {
          items = await fetchMetingPlaylist(playlistId, { signal: fetchController.signal });
        }

        tracks = items
          .slice(0, 250)
          .map((item, index) => toTrack(item, index))
          // 自建歌单中网易云曲目可能暂未解析出地址，保留条目供播放时解析。
          .filter((track) => track.url || (track.neteaseId && track.source === 'netease'));

        if (!tracks.length) throw new Error('Playlist is empty');
        const requestedIndex = Number(saved.index);
        currentIndex = Number.isInteger(requestedIndex)
          ? Math.min(tracks.length - 1, Math.max(0, requestedIndex))
          : 0;
        loadedIndex = -1;
        failedTracks = new Set();
        renderTracks();
        showTrack(currentIndex);
        setControlsDisabled(false);
        setStatus('准备就绪');
      } catch (error) {
        if (error?.name === 'AbortError') setStatus('歌单连接超时');
        else setStatus('歌单暂时无法加载');
        title.textContent = '稍后再试';
        artist.textContent = '也可以前往网易云查看歌单';
        count.textContent = '0/0';
        list.innerHTML = '<li class="music-player__empty">音乐接口暂时不可用，请稍后重试。</li>';
        retryButton?.removeAttribute('hidden');
      } finally {
        window.clearTimeout(timeout);
      }
    };

    // 网易云曲目地址过期/失效时向后端请求一次重新解析，成功后继续播放。
    const resolveNeteaseUrl = async (track) => {
      if (!track?.neteaseId) return '';
      try {
        const path = `/api/public/playlist/resolve/${track.neteaseId}`;
        const request = window.__blogApi?.gateFetch
          ? window.__blogApi.gateFetch(path, { headers: { Accept: 'application/json' } })
          : fetch(gatewayUrl(path), { headers: { Accept: 'application/json' } });
        const res = await request;
        if (!res || !res.ok) return '';
        const data = await res.json();
        return safeUrl(data?.url);
      } catch {
        return '';
      }
    };

    toggle.addEventListener('click', () => {
      setOpen(!root.classList.contains('is-open'));
    });

    closeButton?.addEventListener('click', () => {
      setOpen(false);
      toggle.focus();
    });

    document.addEventListener('pointerdown', (event) => {
      if (root.classList.contains('is-open') && !root.contains(event.target)) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });

    playButton.addEventListener('click', () => {
      if (audio.paused) playCurrent();
      else {
        playGeneration += 1;
        wantsPlayback = false;
        audio.pause();
      }
    });

    prevButton.addEventListener('click', () => {
      const keepPlaying = wantsPlayback && !audio.paused;
      selectTrack(getAdjacentIndex(-1), keepPlaying);
    });

    nextButton.addEventListener('click', () => {
      const keepPlaying = wantsPlayback && !audio.paused;
      selectTrack(getAdjacentIndex(1), keepPlaying);
    });

    muteButton.addEventListener('click', () => {
      audio.muted = !audio.muted;
    });

    // 歌词显示开关：状态记进本地偏好，换会话保持。
    lyricToggle?.addEventListener('click', () => {
      lyricsVisible = !lyricsVisible;
      applyLyricsVisibility();
      persist();
      if (lyricsVisible && lyrics.length) {
        lyricsBox?.querySelector('.is-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });

    shuffleButton?.addEventListener('click', () => {
      shuffleEnabled = !shuffleEnabled;
      shuffleButton.setAttribute('aria-pressed', String(shuffleEnabled));
      shuffleButton.title = shuffleEnabled ? '关闭随机播放' : '随机播放';
      persist();
    });

    repeatButton?.addEventListener('click', () => {
      repeatOne = !repeatOne;
      audio.loop = repeatOne;
      repeatButton.setAttribute('aria-pressed', String(repeatOne));
      repeatButton.title = repeatOne ? '关闭单曲循环' : '单曲循环';
      persist();
    });

    favoriteButton?.addEventListener('click', () => {
      if (!tracks.length) return;
      const key = getTrackKey(tracks[currentIndex]);
      if (favorites.has(key)) favorites.delete(key);
      else favorites.add(key);
      updateFavoriteState();
      persist();
    });

    retryButton?.addEventListener('click', loadPlaylist);

    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-track-index]');
      if (!button || !list.contains(button)) return;
      selectTrack(Number(button.dataset.trackIndex), true);
    });

    progress.addEventListener('input', () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const ratio = Number(progress.value) / 1000;
      progress.style.setProperty('--music-progress', `${ratio * 100}%`);
      progress.parentElement?.style.setProperty('--music-progress', `${ratio * 100}%`);
      audio.currentTime = ratio * audio.duration;
      progress.setAttribute(
        'aria-valuetext',
        `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`,
      );
    });

    audio.addEventListener('loadstart', () => {
      if (wantsPlayback) {
        root.classList.add('is-loading');
        setStatus('正在缓冲…');
      }
    });

    audio.addEventListener('playing', () => {
      wantsPlayback = true;
      root.classList.remove('is-loading');
      root.classList.add('is-playing');
      playButton.setAttribute('aria-label', '暂停');
      playButton.title = '暂停';
      setStatus('正在播放');
    });

    audio.addEventListener('pause', () => {
      root.classList.remove('is-playing', 'is-loading');
      playButton.setAttribute('aria-label', '播放');
      playButton.title = '播放';
      if (!wantsPlayback && audio.currentTime > 0 && !audio.ended) setStatus('已暂停');
    });

    audio.addEventListener('waiting', () => {
      if (wantsPlayback) {
        root.classList.add('is-loading');
        setStatus('网络缓冲中…');
      }
    });

    audio.addEventListener('loadedmetadata', () => {
      progress.disabled = !Number.isFinite(audio.duration);
      if (duration) duration.textContent = formatTime(audio.duration);
      progress.setAttribute(
        'aria-valuetext',
        `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`,
      );
    });

    audio.addEventListener('timeupdate', () => {
      updateLyricHighlight(audio.currentTime);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const ratio = audio.currentTime / audio.duration;
        progress.value = String(Math.round(ratio * 1000));
        progress.style.setProperty('--music-progress', `${ratio * 100}%`);
        progress.parentElement?.style.setProperty('--music-progress', `${ratio * 100}%`);
        if (currentTime) currentTime.textContent = formatTime(audio.currentTime);
        if (duration) duration.textContent = formatTime(audio.duration);
        progress.setAttribute(
          'aria-valuetext',
          `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`,
        );
      }
    });

    audio.addEventListener('ended', () => {
      selectTrack(repeatOne ? currentIndex : getAdjacentIndex(1), true, false);
    });
    audio.addEventListener('error', () => {
      // 播放出错时先尝试重新解析一次网易云地址（外链会过期），
      // 仍失败才跳下一首，避免因地址过期整单跳过。
      const track = tracks[currentIndex];
      const retried = track && track.neteaseId && !failedTracks.has(currentIndex);
      if (retried) {
        track.url = '';
        loadedIndex = -1;
        playCurrent();
        return;
      }
      scheduleSkip();
    });
    audio.addEventListener('volumechange', () => {
      root.classList.toggle('is-muted', audio.muted || audio.volume === 0);
      muteButton.setAttribute('aria-label', audio.muted ? '恢复声音' : '静音');
      muteButton.title = audio.muted ? '恢复声音' : '静音';
      persist();
    });

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', playCurrent);
        navigator.mediaSession.setActionHandler('pause', () => {
          playGeneration += 1;
          wantsPlayback = false;
          audio.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => selectTrack(getAdjacentIndex(-1), true));
        navigator.mediaSession.setActionHandler('nexttrack', () => selectTrack(getAdjacentIndex(1), true));
      } catch {
      }
    }

    applyLyricsVisibility();
    loadPlaylist();
  };

  document.querySelectorAll('[data-music-player]').forEach(initPlayer);
})();
