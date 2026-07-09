/**
 * BullDB Documentation App Logic
 */

document.addEventListener("DOMContentLoaded", () => {
    // State management
    let state = {
        versions: ["1.0.0"],
        currentVersion: "1.0.0",
        currentPage: "README", // Default page
        theme: localStorage.getItem("theme") || "dark",
        searchIndex: []
    };

    // DOM Elements
    const docContent = document.getElementById("doc-content");
    const versionSelect = document.getElementById("version-select");
    const themeToggle = document.getElementById("theme-toggle");
    const mobileToggle = document.getElementById("mobile-toggle");
    const sidebarNav = document.getElementById("sidebar-nav");
    const tocList = document.getElementById("toc-list");
    const searchInput = document.getElementById("search-input");
    const searchResults = document.getElementById("search-results");
    const heroBanner = document.getElementById("hero-banner");
    const brandLink = document.getElementById("brand-link");
    const progressBar = document.getElementById("progress-bar");
    
    // Page Routing map (hash -> file basename)
    const pageMap = {
        "readme": "README",
        "vision": "vision",
        "architecture": "architecture",
        "diagrams": "diagrams"
    };

    // Initialize application
    async function init() {
        // Apply initial theme
        document.documentElement.setAttribute("data-theme", state.theme);
        
        // Initialize Mermaid
        if (window.mermaid) {
            mermaid.initialize({
                startOnLoad: false,
                theme: state.theme === "light" ? "default" : "dark",
                securityLevel: 'loose'
            });
        }

        // Setup marked options
        marked.setOptions({
            gfm: true,
            breaks: true,
            headerIds: true,
            mangle: false
        });

        // 1. Fetch versions from local registry
        try {
            const resp = await fetch("versions/list.json");
            if (resp.ok) {
                const list = await resp.json();
                if (Array.isArray(list) && list.length > 0) {
                    state.versions = list;
                    state.currentVersion = list[0];
                }
            }
        } catch (e) {
            console.log("Using default fallback versions list.", e);
        }

        // 2. Enhance version selection by fetching all tags from GitHub API
        try {
            const tagsResp = await fetch("https://api.github.com/repos/vikukumar/bulldb/tags");
            if (tagsResp.ok) {
                const tagsData = await tagsResp.json();
                const tagNames = tagsData.map(t => t.name.replace(/^v/, ""));
                const combined = [...new Set([...state.versions, ...tagNames])];
                // Sort semver descending
                combined.sort((a, b) => {
                    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
                });
                if (combined.length > 0) {
                    state.versions = combined;
                    state.currentVersion = combined[0];
                }
            }
        } catch (e) {
            console.warn("Could not fetch tags from GitHub API, using local versions registry:", e);
        }

        // 3. Populate version dropdown selector
        populateVersionSelect();

        // 4. Listen to navigation events
        window.addEventListener("hashchange", handleHashChange);
        versionSelect.addEventListener("change", handleVersionSelect);
        themeToggle.addEventListener("click", toggleTheme);
        mobileToggle.addEventListener("click", toggleMobileSidebar);
        searchInput.addEventListener("input", handleSearchInput);
        
        // Hide search dropdown if clicked outside
        document.addEventListener("click", (e) => {
            if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
                searchResults.classList.remove("active");
            }
        });

        brandLink.addEventListener("click", (e) => {
            e.preventDefault();
            window.location.hash = "#readme";
        });

        // 5. Trigger initial page load
        handleHashChange();

        // 6. Build client search index in background
        buildSearchIndex();
    }

    // Populate version selector dropdown
    function populateVersionSelect() {
        versionSelect.innerHTML = "";
        state.versions.forEach(v => {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = `v${v}`;
            opt.selected = v === state.currentVersion;
            versionSelect.appendChild(opt);
        });
    }

    // Toggle Light/Dark mode
    function toggleTheme() {
        state.theme = state.theme === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", state.theme);
        localStorage.setItem("theme", state.theme);
        if (window.mermaid) {
            mermaid.initialize({
                startOnLoad: false,
                theme: state.theme === "light" ? "default" : "dark",
                securityLevel: 'loose'
            });
        }
        loadDocument();
    }

    // Toggle mobile sidebar active state
    function toggleMobileSidebar() {
        sidebarNav.classList.toggle("active");
    }

    // Handle dropdown version selection
    function handleVersionSelect(e) {
        state.currentVersion = e.target.value;
        // Update URL hash with version query parameter or just reload page with same route
        updateUrlHash();
    }

    // Update URL hash state
    function updateUrlHash() {
        window.location.hash = `#v=${state.currentVersion}&p=${state.currentPage.toLowerCase()}`;
    }

    // Parse URL hash parameters
    function handleHashChange() {
        // Hide mobile sidebar if active on navigation
        sidebarNav.classList.remove("active");

        const hash = window.location.hash.substring(1);
        let page = "readme";
        let version = state.currentVersion;

        if (hash) {
            // Check if standard key-value hash exists: #v=X.Y.Z&p=page-name
            if (hash.includes("v=") || hash.includes("p=")) {
                const params = new URLSearchParams(hash);
                const pVal = params.get("p");
                const vVal = params.get("v");
                
                if (pVal && pageMap[pVal.toLowerCase()]) {
                    page = pVal.toLowerCase();
                }
                if (vVal && state.versions.includes(vVal)) {
                    version = vVal;
                }
            } else {
                // Legacy simple hash compatibility: #architecture
                if (pageMap[hash.toLowerCase()]) {
                    page = hash.toLowerCase();
                }
            }
        }

        state.currentVersion = version;
        state.currentPage = pageMap[page] || "README";
        
        // Update selector state if changed
        versionSelect.value = state.currentVersion;

        // Load document
        loadDocument();
    }

    // Load and Render Markdown document
    async function loadDocument() {
        showProgress(30);
        showLoader();

        // Determine markdown file fetch path
        // During development or on local preview, files can fall back to local root files 
        // if the version folder is not built yet.
        let filePath = `versions/${state.currentVersion}/${state.currentPage}.md`;
        
        // Special mapping for README
        if (state.currentPage === "README") {
            filePath = `versions/${state.currentVersion}/README.md`;
        }

        try {
            let response = await fetch(filePath);
            
            // If the versioned file is not found (404), fallback to the local root files
            // (very useful for local development/preview before push deploy pipeline triggers)
            if (!response.ok) {
                let fallbackPath = `../docs/${state.currentPage}.md`;
                if (state.currentPage === "README") {
                    fallbackPath = `../README.md`;
                }
                response = await fetch(fallbackPath);
            }

            // If it still fails, load from GitHub raw content directly for this tag/version
            if (!response.ok) {
                const gitTag = `v${state.currentVersion}`;
                let githubRawPath = `https://raw.githubusercontent.com/vikukumar/bulldb/${gitTag}/docs/${state.currentPage}.md`;
                if (state.currentPage === "README") {
                    githubRawPath = `https://raw.githubusercontent.com/vikukumar/bulldb/${gitTag}/README.md`;
                }
                response = await fetch(githubRawPath);
            }

            if (!response.ok) {
                throw new Error("Page not found");
            }

            const markdownText = await response.text();
            renderMarkdown(markdownText);
        } catch (err) {
            console.error(err);
            docContent.innerHTML = `
                <div style="padding: 3rem 0; text-align: center;">
                    <i data-lucide="alert-circle" style="width: 48px; height: 48px; color: var(--code-keyword); margin-bottom: 1rem;"></i>
                    <h2>Failed to load page</h2>
                    <p style="color: var(--text-secondary); margin-top: 0.5rem;">The documentation file for version v${state.currentVersion} could not be loaded.</p>
                    <a href="#readme" style="color: var(--primary); text-decoration: none; display: inline-block; margin-top: 1rem; font-weight: 600;">Return to Home</a>
                </div>
            `;
            lucide.createIcons();
            hideProgress();
        }
    }

    // Render Mermaid diagrams dynamically
    function renderMermaid() {
        const blocks = docContent.querySelectorAll("pre code.language-mermaid");
        if (blocks.length === 0) return;

        blocks.forEach((block, idx) => {
            const pre = block.parentElement;
            const div = document.createElement("div");
            div.className = "mermaid";
            div.id = `mermaid-svg-${idx}`;
            // Extract raw text and replace html entities
            const temp = document.createElement("textarea");
            temp.innerHTML = block.innerHTML;
            div.textContent = temp.value;
            pre.replaceWith(div);
        });

        if (window.mermaid) {
            const mermaidDivs = docContent.querySelectorAll(".mermaid");
            try {
                mermaidDivs.forEach(div => {
                    div.removeAttribute("data-processed");
                });
                if (typeof mermaid.init === "function") {
                    mermaid.init(undefined, mermaidDivs);
                } else if (typeof mermaid.run === "function") {
                    mermaid.run({ nodes: mermaidDivs });
                }
            } catch (err) {
                console.error("Mermaid rendering failed:", err);
            }
        }
    }

    // Render markdown content using marked.js
    function renderMarkdown(markdown) {
        showProgress(70);
        
        // Hide Hero banner if we are not on the welcome page (README)
        if (state.currentPage === "README") {
            heroBanner.style.display = "block";
        } else {
            heroBanner.style.display = "none";
        }

        // Render HTML content
        docContent.innerHTML = marked.parse(markdown);
        
        // Process and render Mermaid blocks
        renderMermaid();
        
        // Highlight custom pre code keywords
        highlightCodeBlocks();

        // Active Sidebar navigation updates
        updateActiveSidebarLink();

        // Extract headings to build the Table of Contents (Outline)
        buildTOC();

        // Setup page navigation footer
        updateFooterNav();

        // Render icons
        lucide.createIcons();
        
        showProgress(100);
        setTimeout(hideProgress, 300);
    }

    // Build the outline outline menu on the right
    function buildTOC() {
        tocList.innerHTML = "";
        const headings = docContent.querySelectorAll("h2, h3");

        if (headings.length === 0) {
            tocList.innerHTML = `<li><span style="color: var(--text-muted)">No outline on this page</span></li>`;
            return;
        }

        headings.forEach((heading, idx) => {
            // Assign unique ID to heading if not already present
            if (!heading.id) {
                heading.id = `heading-${idx}`;
            }

            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = `#${heading.id}`;
            a.textContent = heading.textContent;
            a.classList.add("toc-link");
            if (heading.tagName === "H3") {
                a.classList.add("h3");
            }

            // Click listener for smooth scroll
            a.addEventListener("click", (e) => {
                e.preventDefault();
                heading.scrollIntoView({ behavior: "smooth" });
            });

            li.appendChild(a);
            tocList.appendChild(li);
        });
    }

    // Custom simple code highlighter
    function highlightCodeBlocks() {
        const codes = docContent.querySelectorAll("pre code");
        codes.forEach(block => {
            const rawText = block.innerHTML;
            // Simple replace of standard keywords with class wrappers
            let highlighted = rawText
                .replace(/\b(class|extends|import|from|def|fn|pub|static|async|await|let|const|var|return|using|namespace|public|struct|interface|where|impl)\b/g, '<span class="token-keyword">$1</span>')
                .replace(/(["'`])(.*?)\1/g, '<span class="token-string">$&</span>')
                .replace(/(#|\/\/).*?(\n|$)/g, '<span class="token-comment">$&</span>');
            block.innerHTML = highlighted;
        });
    }

    // Highlight the active page in sidebar navigation
    function updateActiveSidebarLink() {
        const links = document.querySelectorAll(".menu-link");
        links.forEach(l => {
            const pageName = l.getAttribute("data-page");
            if (pageName === state.currentPage) {
                l.classList.add("active");
            } else {
                l.classList.remove("active");
            }
        });
    }

    // Setup next / previous buttons in footer
    function updateFooterNav() {
        const prevLink = document.getElementById("prev-link");
        const nextLink = document.getElementById("next-link");
        
        const orderedPages = ["README", "vision", "architecture", "diagrams"];
        const currentIndex = orderedPages.indexOf(state.currentPage);

        // Map page back to hash name
        const hashNames = {
            "README": "readme",
            "vision": "vision",
            "architecture": "architecture",
            "diagrams": "diagrams"
        };

        const pageTitles = {
            "README": "Overview & Installation",
            "vision": "Vision & Mission",
            "architecture": "Core Design",
            "diagrams": "System Diagrams"
        };

        // Previous link
        if (currentIndex > 0) {
            const prevPage = orderedPages[currentIndex - 1];
            prevLink.href = `#v=${state.currentVersion}&p=${hashNames[prevPage]}`;
            prevLink.querySelector(".nav-title").textContent = pageTitles[prevPage];
            prevLink.style.visibility = "visible";
        } else {
            prevLink.style.visibility = "hidden";
        }

        // Next link
        if (currentIndex < orderedPages.length - 1 && currentIndex !== -1) {
            const nextPage = orderedPages[currentIndex + 1];
            nextLink.href = `#v=${state.currentVersion}&p=${hashNames[nextPage]}`;
            nextLink.querySelector(".nav-title").textContent = pageTitles[nextPage];
            nextLink.style.visibility = "visible";
        } else {
            nextLink.style.visibility = "hidden";
        }
    }

    // Build client-side index of all markdown documents for offline search
    async function buildSearchIndex() {
        const pages = ["README", "vision", "architecture", "diagrams"];
        
        for (const p of pages) {
            let filePath = `versions/${state.currentVersion}/${p}.md`;
            if (p === "README") {
                filePath = `versions/${state.currentVersion}/README.md`;
            }

            try {
                let response = await fetch(filePath);
                if (!response.ok) {
                    let fallbackPath = `../docs/${p}.md`;
                    if (p === "README") {
                        fallbackPath = `../README.md`;
                    }
                    response = await fetch(fallbackPath);
                }

                if (response.ok) {
                    const text = await response.text();
                    
                    // Simple parser to extract lines/headers
                    const lines = text.split("\n");
                    let currentSection = "";

                    lines.forEach(line => {
                        line = line.trim();
                        if (line.startsWith("#")) {
                            currentSection = line.replace(/#/g, "").trim();
                        } else if (line.length > 15) {
                            // Only index content lines that have content
                            state.searchIndex.push({
                                page: p,
                                section: currentSection || p,
                                text: line.replace(/[*_`\[\]]/g, "") // strip styling
                            });
                        }
                    });
                }
            } catch (e) {
                console.warn("Failed to index page for search:", p);
            }
        }
    }

    // Handle query search keyups
    function handleSearchInput(e) {
        const query = e.target.value.toLowerCase().trim();
        searchResults.innerHTML = "";

        if (!query) {
            searchResults.classList.remove("active");
            return;
        }

        // Filter the search index
        const matches = state.searchIndex.filter(item => 
            item.text.toLowerCase().includes(query) || 
            item.section.toLowerCase().includes(query)
        ).slice(0, 8); // Limit to 8 matches

        if (matches.length === 0) {
            searchResults.innerHTML = `<div class="search-item"><span style="color: var(--text-muted);">No results found</span></div>`;
        } else {
            const pageHashes = {
                "README": "readme",
                "vision": "vision",
                "architecture": "architecture",
                "diagrams": "diagrams"
            };

            matches.forEach(m => {
                const div = document.createElement("div");
                div.classList.add("search-item");
                
                div.innerHTML = `
                    <div class="search-item-title">${m.section}</div>
                    <div class="search-item-snippet">in ${m.page} &middot; ${escapeHtml(m.text)}</div>
                `;

                div.addEventListener("click", () => {
                    window.location.hash = `#v=${state.currentVersion}&p=${pageHashes[m.page]}`;
                    searchInput.value = "";
                    searchResults.classList.remove("active");
                });

                searchResults.appendChild(div);
            });
        }

        searchResults.classList.add("active");
    }

    function escapeHtml(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Progress Bar Utilities
    function showProgress(pct) {
        progressBar.style.width = `${pct}%`;
    }

    function hideProgress() {
        progressBar.style.width = "0%";
    }

    // Loading overlay
    function showLoader() {
        docContent.innerHTML = `
            <div class="loading-container">
                <div class="spinner"></div>
                <p>Loading documentation...</p>
            </div>
        `;
    }

    // Run app
    init();
});
