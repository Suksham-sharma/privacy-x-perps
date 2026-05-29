"use client";

import { useEffect, useState } from "react";
import { IcebergMark } from "./IcebergMark";

export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={scrolled ? "scrolled" : undefined}>
      <div className="wrap nav">
        <a href="#" className="brand">
          <IcebergMark size={28} className="mark" />
          <span className="name">
            Ice<em>berg</em>
          </span>
        </a>
        <nav className="nav-links">
          <a href="#terminal">Terminal</a>
          <a href="#how">Lifecycle</a>
          <a href="#compare">Compare</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-cta">
          <a href="/trade" className="btn btn-accent btn-sm">
            Launch Terminal{" "}
            <svg className="ic arrow">
              <use href="#i-arrow" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
}
