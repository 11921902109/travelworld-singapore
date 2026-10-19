"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Coffee,
  Compass,
  Footprints,
  Hotel,
  MapPin,
  Route,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrainFront,
  Utensils,
} from "lucide-react";
import { TravelLogo } from "@/components/travel/travel-logo";

const sampleStops = [
  { name: "Bugis", time: "09:30", x: 29, y: 27, type: "hotel" },
  { name: "Kampong Glam", time: "09:42", x: 43, y: 21, type: "place" },
  { name: "Gardens by the Bay", time: "16:50", x: 72, y: 61, type: "place" },
  { name: "Marina Bay", time: "19:24", x: 62, y: 51, type: "place" },
];

const itinerary = [
  { time: "09:30", title: "从 Bugis 出发", meta: "酒店锚点", icon: Hotel },
  { time: "09:42", title: "哈芝巷与苏丹回教堂", meta: "步行 12 min · 游玩 1 h 20 min", icon: Building2 },
  { time: "12:05", title: "老巴刹午餐", meta: "地铁 18 min · 用餐 1 h", icon: Utensils },
  { time: "16:50", title: "滨海湾花园", meta: "地铁 22 min · 游玩 2 h 20 min", icon: MapPin },
  { time: "19:24", title: "滨海湾夜景", meta: "步行 9 min · 预计 21:00 返回", icon: Compass },
];

function StoryActLabel({ number, label }: { number: string; label: string }) {
  return (
    <div className="tw-act-label" aria-hidden="true">
      <span>{number}</span>
      <small>{label}</small>
    </div>
  );
}

export function TravelLandingClient() {
  const scrollRoot = useRef<HTMLDivElement>(null);
  const storyRoot = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [activeAct, setActiveAct] = useState(1);

  const scrollToLandingSection = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const root = scrollRoot.current;
    const target = root?.querySelector<HTMLElement>(`#${id}`);
    if (!root || !target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top = root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 88;
    root.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : "smooth" });
    if (window.location.hash !== `#${id}`) window.history.pushState(null, "", `#${id}`);
  };

  useEffect(() => {
    const root = scrollRoot.current;
    const story = storyRoot.current;
    if (!root || !story) return;

    let scheduled = false;
    let animationFrame = 0;
    const updateStory = () => {
      setScrolled(root.scrollTop > 24);
      const start = story.offsetTop;
      const travel = Math.max(1, story.scrollHeight - root.clientHeight * 0.6);
      const progress = Math.min(1, Math.max(0, (root.scrollTop - start + root.clientHeight * 0.18) / travel));
      story.style.setProperty("--story-progress", progress.toFixed(4));
      scheduled = false;
    };
    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      animationFrame = requestAnimationFrame(updateStory);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(onScroll);
    resizeObserver.observe(story);
    updateStory();

    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    }, { root, threshold: 0.14 });
    root.querySelectorAll(".tw-reveal").forEach((element) => revealObserver.observe(element));

    const actObserver = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const nextAct = Number((visible.target as HTMLElement).dataset.storyAct);
      if (nextAct) setActiveAct(nextAct);
    }, { root, threshold: [0.25, 0.45, 0.65], rootMargin: "-12% 0px -28%" });
    root.querySelectorAll("[data-story-act]").forEach((element) => actObserver.observe(element));

    return () => {
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resizeObserver.disconnect();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      revealObserver.disconnect();
      actObserver.disconnect();
    };
  }, []);

  return (
    <div className="tw-page-scroll" ref={scrollRoot}>
      <header className="tw-nav" data-scrolled={scrolled}>
        <TravelLogo />
        <nav aria-label="主要导航">
          <a href="#understood" onClick={(event) => scrollToLandingSection(event, "understood")}>它如何理解</a>
          <a href="#revealed" onClick={(event) => scrollToLandingSection(event, "revealed")}>路线显影</a>
          <a href="/travel/new">开始规划</a>
        </nav>
        <a className="tw-nav-cta" href="/travel/demo-singapore#case-walkthrough">先看新加坡样例 <ArrowRight size={15} /></a>
      </header>

      <main className="tw-story-surface" ref={storyRoot}>
        <svg className="tw-story-thread" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path className="tw-story-thread__base" d="M88 2 C97 10 96 17 89 22 C77 30 8 26 7 37 C6 47 94 46 93 58 C92 69 8 67 8 78 C8 88 78 86 88 98" pathLength="1" />
          <path className="tw-story-thread__progress" d="M88 2 C97 10 96 17 89 22 C77 30 8 26 7 37 C6 47 94 46 93 58 C92 69 8 67 8 78 C8 88 78 86 88 98" pathLength="1" />
        </svg>

        <div className="tw-story-progress" aria-hidden="true">
          <b>{String(activeAct).padStart(2, "0")}</b><span>/ 06</span>
          <i><em style={{ transform: `scaleY(${activeAct / 6})` }} /></i>
        </div>

        <section className="tw-hero" data-story-act="1">
          <StoryActLabel number="01" label="WISH" />
          <div className="tw-hero-copy">
            <p className="tw-eyebrow tw-reveal"><span /> SAY IT. SEE IT. WALK IT.</p>
            <h1 className="tw-hero-title" aria-label="把想去的地方，变成走得通的旅程">
              <span>把想去的地方，</span>
              <span>变成<span className="tw-route-underline">走得通</span>的旅程。</span>
            </h1>
            <p className="tw-hero-lead tw-reveal">你只需要说出旅行愿望。travelworld 会先理解，再确认，最后让酒店、景点、交通和每一段时间在地图上显影。</p>

            <div className="tw-hero-actions tw-reveal" aria-label="开始方式">
              <a className="tw-button" href="/travel/new">开始我的旅行 <ArrowRight size={17} /></a>
              <a className="tw-button tw-button--secondary" href="/travel/demo-singapore#case-walkthrough">先看新加坡样例 <Compass size={17} /></a>
            </div>

            <div className="tw-trust-row tw-reveal">
              <span><ShieldCheck size={15} /> 地点经过校验</span>
              <span><Route size={15} /> 路线单独计算</span>
              <span><Hotel size={15} /> 酒店作为每日锚点</span>
            </div>
          </div>

          <figure className="tw-hero-visual">
            <figcaption className="tw-sr-only">新加坡四日行程预览</figcaption>
            <div className="tw-map-thread tw-map-thread--one" />
            <div className="tw-map-thread tw-map-thread--two" />
            <div className="tw-preview-window">
              <div className="tw-preview-head">
                <div><small>SINGAPORE · 4 DAYS</small><strong>日光与夜色</strong></div>
                <span>已排好</span>
              </div>
              <div className="tw-preview-map">
                <svg viewBox="0 0 100 78" aria-hidden="true">
                  <path className="tw-preview-island" d="M5 29 C13 14 28 12 39 17 C51 11 66 16 75 25 C87 23 97 30 94 42 C86 50 74 55 65 61 C51 69 34 64 23 59 C12 55 3 43 5 29Z" />
                  <path className="tw-preview-road" d="M13 29 C32 31 43 38 55 42 C68 47 79 43 91 36" />
                  <path className="tw-preview-route" d="M29 27 C36 23 39 22 43 21 C55 24 68 42 72 61 C70 57 66 52 62 51" />
                </svg>
                {sampleStops.map((stop, index) => (
                  <span key={stop.name} className={`tw-preview-pin ${stop.type === "hotel" ? "is-hotel" : ""}`} style={{ left: `${stop.x}%`, top: `${stop.y}%` }}>
                    {stop.type === "hotel" ? <Hotel size={12} /> : index}
                    <em>{stop.time}</em>
                  </span>
                ))}
                <div className="tw-preview-route-pill"><Route size={14} /><span>地铁 22 min</span></div>
              </div>
              <div className="tw-preview-timeline">
                <span className="is-active"><b>09:42</b><i /><strong>哈芝巷</strong><small>步行 12 min</small></span>
                <span><b>16:50</b><i /><strong>滨海湾花园</strong><small>游玩 2 h 20 min</small></span>
                <span><b>19:24</b><i /><strong>滨海湾夜景</strong><small>预计 21:00 返回</small></span>
              </div>
            </div>
            <div className="tw-floating-note tw-floating-note--verified"><CheckCircle2 size={17} /><span><small>地点状态</small>4 个已验证</span></div>
            <div className="tw-floating-note tw-floating-note--pace"><Clock3 size={17} /><span><small>旅行节奏</small>轻松 · 不早起</span></div>
          </figure>
        </section>

        <section className="tw-story-act tw-story-act--understood" id="understood" data-story-act="2">
          <StoryActLabel number="02" label="UNDERSTOOD" />
          <div className="tw-story-copy tw-reveal">
            <p className="tw-eyebrow"><span /> FIRST, BE UNDERSTOOD</p>
            <h2>它先听懂你，<br />而不是急着给答案。</h2>
            <p>一句自然语言里，藏着城市、日期、住宿、兴趣和旅行节奏。travelworld 会把这些条件摊开给你确认，不让任何假设悄悄进入行程。</p>
          </div>
          <div className="tw-language-stage tw-reveal">
            <div className="tw-language-prompt">
              <Sparkles size={18} />
              <p>“我想去 <mark>新加坡 4 天</mark>，住 <mark>Bugis</mark>，<br />喜欢 <mark>建筑</mark>、<mark>美食</mark>和<mark>夜景</mark>，<br />而且<mark>不想早起</mark>。”</p>
            </div>
            <div className="tw-language-result">
              <span><small>目的地</small><b>新加坡</b></span>
              <span><small>住宿区域</small><b>Bugis</b></span>
              <span><small>旅行时间</small><b>4 天</b></span>
              <span><small>兴趣</small><b>建筑 · 美食 · 夜景</b></span>
              <span><small>节奏</small><b>轻松 · 不早起</b></span>
            </div>
            <div className="tw-verified-line"><ShieldCheck size={16} /><span>5 类条件已识别，等待你的确认</span><CheckCircle2 size={17} /></div>
          </div>
        </section>

        <section className="tw-story-act tw-story-act--composed" data-story-act="3">
          <StoryActLabel number="03" label="COMPOSED" />
          <div className="tw-compose-heading tw-reveal">
            <p className="tw-eyebrow"><span /> THEN, MAKE A DAY</p>
            <h2>条件开始有顺序，<br />一天开始有呼吸。</h2>
            <p>酒店是锚点，交通是间距，预约和营业时间是边界。每一个地点都必须落在真实的一天里。</p>
          </div>
          <div className="tw-compose-board tw-reveal">
            <div className="tw-compose-summary">
              <span>DAY 01</span>
              <h3>建筑与夜色</h3>
              <p>10:30 出门 · 21:00 返回</p>
              <div><b>4</b><small>地点</small><b>53 min</b><small>总交通</small></div>
            </div>
            <ol className="tw-compose-timeline">
              {itinerary.map((item, index) => {
                const Icon = item.icon;
                return (
                  <li key={item.title} style={{ "--item-index": index } as CSSProperties}>
                    <time>{item.time}</time>
                    <span><Icon size={16} /></span>
                    <div><strong>{item.title}</strong><small>{item.meta}</small></div>
                  </li>
                );
              })}
            </ol>
            <div className="tw-compose-rules">
              <article><Clock3 size={18} /><span><small>时间缓冲</small><b>每段预留 10–20 min</b></span></article>
              <article><TrainFront size={18} /><span><small>路线原则</small><b>同一区域连续安排</b></span></article>
              <article><Coffee size={18} /><span><small>节奏保护</small><b>下午保留一次休息</b></span></article>
            </div>
          </div>
        </section>

        <section className="tw-story-act tw-story-act--revealed" id="revealed" data-story-act="4">
          <StoryActLabel number="04" label="REVEALED" />
          <div className="tw-reveal-heading tw-reveal">
            <p className="tw-eyebrow"><span /> NOW, SEE THE WHOLE JOURNEY</p>
            <h2>然后，整段旅程在地图上显影。</h2>
            <p>在完整行程中，点击地图上的点，时间轴会找到同一个地点；调整时间轴，路线也会同步变化。自然语言到这里不再是一段答案，而是一张可以执行的地图。</p>
          </div>
          <div className="tw-reveal-product tw-reveal">
            <div className="tw-reveal-map">
              <div className="tw-reveal-map-head"><span><i />DAY 01 · 建筑与夜色</span><small>路线已校验 · 10:30—21:00</small></div>
              <svg viewBox="0 0 100 72" role="img" aria-label="新加坡第一天路线地图预览">
                <path className="tw-reveal-island" d="M3 28 C10 14 28 9 40 16 C53 9 68 14 76 23 C91 20 99 30 94 43 C84 49 77 58 65 62 C48 70 30 63 19 58 C8 54 -1 41 3 28Z" />
                <path className="tw-reveal-road" d="M8 29 C24 32 41 42 53 44 C68 47 80 39 92 32" />
                <path className="tw-reveal-road tw-reveal-road--minor" d="M31 13 C35 25 44 37 49 48 C53 57 61 61 72 63" />
                <path className="tw-reveal-route-shadow" d="M27 26 C36 21 42 20 46 25 C51 33 65 45 72 56 C69 53 64 50 60 49" />
                <path className="tw-reveal-route" d="M27 26 C36 21 42 20 46 25 C51 33 65 45 72 56 C69 53 64 50 60 49" />
              </svg>
              {sampleStops.map((stop, index) => (
                <span key={stop.name} className={`tw-reveal-pin ${stop.type === "hotel" ? "is-hotel" : ""}`} style={{ left: `${stop.x}%`, top: `${stop.y}%`, "--pin-delay": `${index * 120}ms` } as CSSProperties}>
                  {stop.type === "hotel" ? <Hotel size={13} /> : index}
                </span>
              ))}
              <div className="tw-reveal-transport"><TrainFront size={15} /><span>地铁 22 min</span></div>
            </div>
            <aside className="tw-reveal-timeline">
              <div><small>DAY 01</small><strong>建筑与夜色</strong><span>4 个地点 · 53 min 交通</span></div>
              <ol>
                {itinerary.slice(0, 4).map((item, index) => (
                  <li key={item.title} className={index === 2 ? "is-active" : ""}>
                    <time>{item.time}</time><i /><span><b>{item.title}</b><small>{item.meta}</small></span>
                  </li>
                ))}
              </ol>
              <a href="/travel/demo-singapore">打开完整可视化行程 <ArrowRight size={16} /></a>
            </aside>
          </div>
        </section>

        <section className="tw-story-act tw-story-act--adjusted" data-story-act="5">
          <StoryActLabel number="05" label="ADJUSTABLE" />
          <div className="tw-adjust-copy tw-reveal">
            <p className="tw-eyebrow"><span /> KEEP IT YOURS</p>
            <h2>不满意？<br />再说一句就好。</h2>
            <p>“第二天下午轻松一点。” travelworld 会先告诉你它准备改什么，再只重算受影响的路段。你锁定的酒店、预约和必去地点不会被覆盖。</p>
            <div className="tw-adjust-guard"><ShieldCheck size={18} /><span><b>先预览，再应用</b><small>所有 AI 修改都可以撤销</small></span></div>
          </div>
          <div className="tw-adjust-stage tw-reveal">
            <div className="tw-adjust-prompt"><Sparkles size={17} /><span>第二天下午轻松一点，保留滨海湾夜景</span><Send size={15} /></div>
            <div className="tw-adjust-diff">
              <article>
                <small>调整前</small><strong>4 个地点</strong><span>步行 7.2 km · 预计 21:40 返回</span>
                <div><i />国家美术馆</div><div><i />牛车水</div><div><i />滨海湾花园</div><div><i />滨海湾夜景</div>
              </article>
              <ArrowRight size={20} aria-hidden="true" />
              <article className="is-after">
                <small>调整后</small><strong>3 个地点</strong><span>步行 4.1 km · 预计 21:00 返回</span>
                <div><CheckCircle2 size={14} />国家美术馆</div><div className="is-rest"><Coffee size={14} />酒店休息 50 min</div><div><CheckCircle2 size={14} />滨海湾花园</div><div><CheckCircle2 size={14} />滨海湾夜景</div>
              </article>
            </div>
            <div className="tw-adjust-status"><SlidersHorizontal size={16} /><span>仅重算 2 段路线 · 酒店与夜景已锁定</span></div>
          </div>
        </section>

        <section className="tw-story-final" data-story-act="6">
          <StoryActLabel number="06" label="DEPARTURE" />
          <div className="tw-final-route" aria-hidden="true"><i /><span /><b /></div>
          <p className="tw-eyebrow tw-reveal"><span /> READY WHEN YOU ARE</p>
          <h2 className="tw-reveal">
            <span className="tw-final-title-line">从下一句话开始，</span>
            <span className="tw-final-title-line">把旅行变成一条走得通的路。</span>
          </h2>
          <p className="tw-reveal">从新加坡开始，或者告诉我们你真正想去的地方。</p>
          <div className="tw-final-actions tw-reveal">
            <a className="tw-button" href="/travel/new">开始我的旅行 <ArrowRight size={17} /></a>
            <a className="tw-button tw-button--ghost" href="/travel/demo-singapore#case-walkthrough">先看新加坡样例</a>
          </div>
          <div className="tw-final-proof tw-reveal">
            <span><CalendarDays size={16} />4 个旅行日</span><span><MapPin size={16} />17 个行程节点</span><span><Footprints size={16} />每段路程可见</span>
          </div>
        </section>
      </main>

      <footer className="tw-footer">
        <TravelLogo />
        <p>自然语言是入口，可执行地图才是答案。</p>
        <small>Motion effects derived from reactbits by DavidHDev (MIT)</small>
      </footer>
    </div>
  );
}
