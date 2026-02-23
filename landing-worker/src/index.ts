interface Env {
    ASSETS: Fetcher;
}

const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ArtGod</title>
    <style>
        :root {
            color-scheme: only light;
            --bg: #292726;
            --text: #dad7cc;
            --sky: #93d1de;
            --sky-dark: #718dbc;
            --accent: #f9a4cb;
            --cta-text: #f8fefe;
            --cta-link: #f6e518;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;
            background: var(--bg);
            color: var(--text);
            font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", serif;
            line-height: 1.75;
        }

        main {
            width: min(1120px, 92vw);
            margin: 0 auto;
            padding: 48px 0 72px;
        }

        .splash-frame {
            display: flex;
            justify-content: center;
            width: 100%;
        }

        .splash {
            width: min(1024px, 100%);
            height: auto;
            aspect-ratio: 1 / 1;
            object-fit: cover;
            border: 1px solid var(--sky-dark);
            display: block;
        }

        article {
            max-width: 72ch;
            margin: 40px auto 0;
            font-size: clamp(1.05rem, 0.98rem + 0.24vw, 1.2rem);
        }

        article p {
            margin: 0;
            color: var(--text);
        }

        article p + p {
            margin-top: 1.2rem;
        }

        article p.lead-paragraph {
            color: var(--sky);
        }

        article ul {
            margin: 0.9rem 0 1.2rem;
            padding-left: 1.35rem;
            color: var(--text);
        }

        article li + li {
            margin-top: 0.55rem;
        }

        .cta {
            margin-top: 2.1rem;
            padding: 1.15rem 1.3rem;
            border-left: 5px solid var(--accent);
            border-top: 1px solid var(--sky-dark);
            border-bottom: 1px solid var(--sky-dark);
            background: var(--sky-dark);
            color: var(--cta-text);
        }

        .cta strong {
            color: var(--cta-text);
        }

        .cta a {
            color: var(--cta-link);
            text-decoration: none;
            border-bottom: 1px solid var(--cta-link);
        }

        .cta a:hover {
            color: var(--cta-link);
            border-bottom-color: var(--cta-link);
            opacity: 0.85;
        }

        @media (max-width: 720px) {
            main {
                padding: 24px 0 56px;
            }

            article {
                margin-top: 28px;
            }
        }
    </style>
</head>
<body>
    <main>
        <div class="splash-frame">
            <img
                class="splash"
                src="/intro.jpg"
                alt="ArtGod intro artwork"
                width="1024"
                height="1024"
            />
        </div>
        <article>
            <p class="lead-paragraph">
                The goal of ArtGod is to reignite interest in digital collectibles and advance
                the frontier in multiple directions:
            </p>
            <ul>
                <li>
                    composable and customizable frontends for NFT collections (self-hosted on your
                    desktop machine and leveraging a built-in indexer)
                </li>
                <li>
                    peer-to-peer social networking (as an exploration of alternatives to Discord,
                    X/CT, and other siloed centralized platforms)
                </li>
                <li>
                    market-making automation (from full integration with OpenSea/Seaport to the
                    exploration of alternative orderbook designs)
                </li>
                <li>excellence in UI/UX for onchain and cross-chain activities</li>
            </ul>
            <p class="lead-paragraph">
                ArtGod is free and copyleft open-source software. There is no funding, no sale, no
                airdrop, no farming, and no token.
            </p>
            <p>
                This project is based on a vision of an all-encompassing, self-sufficient platform
                that empowers users to streamline and automate blockchain interactions, while
                deepening peer-to-peer social experience within an emergent, protocol-native social
                layer.<br />It is being built:
            </p>
            <ul>
                <li>by artists, for artists</li>
                <li>by collectors, for collectors</li>
                <li>by cypherpunks, for cypherpunks</li>
            </ul>
            <section class="cta" aria-label="Call to action">
                Follow
                <a href="https://x.com/artgod_eth" target="_blank" rel="noreferrer noopener">ArtGod on X</a>
                to catch the first public release announcement in the coming weeks.
            </section>
        </article>
    </main>
</body>
</html>
`;

const HTML_HEADERS = {
    "content-type": "text/html; charset=UTF-8",
    "cache-control": "public, max-age=300",
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("Method Not Allowed", {
                status: 405,
                headers: {
                    allow: "GET, HEAD",
                },
            });
        }

        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
            if (request.method === "HEAD") {
                return new Response(null, {
                    status: 200,
                    headers: HTML_HEADERS,
                });
            }

            return new Response(LANDING_PAGE_HTML, {
                status: 200,
                headers: HTML_HEADERS,
            });
        }

        return env.ASSETS.fetch(request);
    },
};
