/**
 * playwright-archaeologist Test Fixture Application
 *
 * A comprehensive Express.js server that exercises every crawler feature.
 * Used as the target for all integration and e2e tests.
 *
 * Usage:
 *   import { startTestApp } from './setup.js';
 *   const { url, close } = await startTestApp();
 *   // ... run tests against url ...
 *   await close();
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Data fixtures
// ---------------------------------------------------------------------------

const TEAM_MEMBERS = [
  { id: 1, name: 'Alice Chen', role: 'Lead Engineer', bio: 'Builds distributed systems at scale.' },
  { id: 2, name: 'Bob Martinez', role: 'Designer', bio: 'Pixel-perfect UI with accessibility in mind.' },
  { id: 3, name: 'Carol Okafor', role: 'PM', bio: 'Keeps the trains running and stakeholders informed.' },
  { id: 4, name: 'Dave Singh', role: 'QA Lead', bio: 'If there is a bug, Dave will find it.' },
];

const BLOG_POSTS = [
  { slug: 'getting-started', title: 'Getting Started with Our Platform', date: '2026-01-15', excerpt: 'Learn how to set up your environment and deploy your first project.', body: 'Welcome to our platform. This guide walks you through initial setup, configuration, and your first deployment. We cover environment variables, database connections, and CI/CD pipelines.' },
  { slug: 'advanced-patterns', title: 'Advanced Architecture Patterns', date: '2026-02-01', excerpt: 'Deep dive into event sourcing, CQRS, and saga patterns.', body: 'Modern applications benefit from event-driven architectures. This post explores event sourcing with append-only logs, CQRS for read/write separation, and sagas for distributed transactions.' },
  { slug: 'performance-tuning', title: 'Performance Tuning Guide', date: '2026-02-20', excerpt: 'Optimize your app from database queries to frontend rendering.', body: 'Performance is a feature. We cover database indexing strategies, query optimization, connection pooling, bundle splitting, lazy loading, and service worker caching.' },
  { slug: 'security-best-practices', title: 'Security Best Practices', date: '2026-03-01', excerpt: 'Protect your application against OWASP Top 10 threats.', body: 'Security requires defense in depth. This post covers input validation, parameterized queries, CSRF tokens, content security policies, and secure cookie configuration.' },
  { slug: 'testing-strategies', title: 'Comprehensive Testing Strategies', date: '2026-03-05', excerpt: 'From unit tests to visual regression, a complete testing pyramid.', body: 'A robust test suite includes unit tests for pure logic, integration tests for module boundaries, and e2e tests for critical user flows. We also discuss snapshot testing and visual regression.' },
  { slug: 'deployment-guide', title: 'Zero-Downtime Deployment Guide', date: '2026-03-08', excerpt: 'Blue-green deployments and rolling updates made simple.', body: 'Zero-downtime deployments require health checks, graceful shutdown, database migration strategies, and traffic shifting. We cover blue-green, canary, and rolling update patterns.' },
];

const USERS_DB = [
  { id: 1, name: 'Alice Chen', email: 'alice@example.com', role: 'admin' },
  { id: 2, name: 'Bob Martinez', email: 'bob@example.com', role: 'editor' },
  { id: 3, name: 'Carol Okafor', email: 'carol@example.com', role: 'viewer' },
];

const POSTS_DB = [
  { id: 1, title: 'First API Post', body: 'This is the body of the first post.', authorId: 1 },
  { id: 2, title: 'Second API Post', body: 'This is the body of the second post.', authorId: 2 },
  { id: 3, title: 'Third API Post', body: 'This is the body of the third post.', authorId: 1 },
];

const AUTH_CREDENTIALS = { email: 'admin@example.com', password: 'password123' };
const SESSION_TOKEN = 'test-session-token-abc123';

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function layout(title: string, body: string, opts: { head?: string } = {}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Test App</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; margin: 0; padding: 0; color: #1a1a1a; background: #fff; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { background: #1a1a2e; color: #fff; padding: 1rem 2rem; }
    nav a { color: #e0e0ff; margin-right: 1.5rem; }
    main { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    footer { background: #f0f0f0; padding: 1rem 2rem; margin-top: 3rem; text-align: center; color: #666; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .btn { display: inline-block; padding: 0.5rem 1rem; background: #0066cc; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem; }
    .btn:hover { background: #0052a3; }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f8f8; font-weight: 600; }
    form .field { margin-bottom: 1rem; }
    form label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
    form input, form select, form textarea { width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; }
    form input[type="checkbox"], form input[type="radio"] { width: auto; }
    .pagination { display: flex; gap: 0.5rem; margin-top: 2rem; }
    .pagination a, .pagination span { padding: 0.5rem 1rem; border: 1px solid #ddd; border-radius: 4px; }
    .pagination .active { background: #0066cc; color: #fff; border-color: #0066cc; }
    .tab-container { margin-top: 1rem; }
    .tab-buttons { display: flex; gap: 0; border-bottom: 2px solid #ddd; }
    .tab-btn { padding: 0.75rem 1.5rem; border: none; background: none; cursor: pointer; font-size: 1rem; border-bottom: 2px solid transparent; margin-bottom: -2px; }
    .tab-btn.active { border-bottom-color: #0066cc; color: #0066cc; font-weight: 600; }
    .tab-panel { padding: 1.5rem 0; display: none; }
    .tab-panel.active { display: block; }
    @media (prefers-color-scheme: dark) {
      body.dark-mode { background: #1a1a2e; color: #e0e0e0; }
      body.dark-mode .card { border-color: #444; }
      body.dark-mode footer { background: #16213e; color: #aaa; }
    }
  </style>
  ${opts.head ?? ''}
</head>
<body>
  <nav aria-label="Main navigation">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="/team">Team</a>
    <a href="/blog">Blog</a>
    <a href="/spa">SPA</a>
    <a href="/hash-app">Hash App</a>
    <a href="/forms/login">Forms</a>
    <a href="/api/users">API</a>
  </nav>
  <main>
    ${body}
  </main>
  <footer>
    <p>Test App for playwright-archaeologist. Built for integration testing.</p>
    <p><a href="/about">About</a> | <a href="/contact">Contact</a> | <a href="/external-links">External Links</a></p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createTestApp(): express.Express {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS for API endpoints
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // =========================================================================
  // STATIC PAGES
  // =========================================================================

  // GET / — Home page
  app.get('/', (_req: Request, res: Response) => {
    res.send(layout('Home', `
      <h1>Welcome to Test App</h1>
      <p>This application is a test fixture for the playwright-archaeologist crawler.</p>
      <h2>Sections</h2>
      <ul>
        <li><a href="/about">About</a> — Static page with landmarks</li>
        <li><a href="/contact">Contact</a> — Headings hierarchy</li>
        <li><a href="/team">Team</a> — Dynamic team listing</li>
        <li><a href="/blog">Blog</a> — Paginated blog posts</li>
        <li><a href="/external-links">External Links</a> — Links to external domains</li>
        <li><a href="/spa">SPA Section</a> — Single-page application with pushState</li>
        <li><a href="/hash-app">Hash App</a> — Hash-based routing</li>
      </ul>
      <h2>Forms</h2>
      <ul>
        <li><a href="/forms/login">Login Form</a></li>
        <li><a href="/forms/register">Registration Form</a></li>
        <li><a href="/forms/search">Search Form</a></li>
        <li><a href="/forms/upload">File Upload</a></li>
        <li><a href="/forms/multi-step">Multi-Step Wizard</a></li>
        <li><a href="/forms/implicit">Implicit Form</a></li>
        <li><a href="/forms/validation">Validation Form</a></li>
        <li><a href="/forms/hidden-in-tab">Hidden in Tab</a></li>
      </ul>
      <h2>API Endpoints</h2>
      <ul>
        <li><a href="/api/users">GET /api/users</a></li>
        <li><a href="/api/posts">GET /api/posts</a></li>
      </ul>
      <h2>Auth</h2>
      <ul>
        <li><a href="/protected">Protected Page</a> (requires auth)</li>
        <li><a href="/protected/dashboard">Protected Dashboard</a></li>
        <li><a href="/protected/settings">Protected Settings</a></li>
      </ul>
      <h2>Error Pages</h2>
      <ul>
        <li><a href="/error/404">404 Error</a></li>
        <li><a href="/error/500">500 Error</a></li>
        <li><a href="/error/timeout">Timeout (60s)</a></li>
        <li><a href="/error/redirect-loop">Redirect Loop</a></li>
        <li><a href="/error/redirect-chain">Redirect Chain</a></li>
      </ul>
      <h2>Special Cases</h2>
      <ul>
        <li><a href="/special/dialog">Alert Dialog</a></li>
        <li><a href="/special/popup">Popup Window</a></li>
        <li><a href="/special/slow">Slow Page (5s)</a></li>
        <li><a href="/special/large-dom">Large DOM (1000+ elements)</a></li>
        <li><a href="/special/lazy-load">Lazy Load</a></li>
        <li><a href="/special/iframe">Same-Origin iFrame</a></li>
        <li><a href="/special/iframe-external">External iFrame</a></li>
        <li><a href="/special/meta-refresh">Meta Refresh</a></li>
        <li><a href="/special/js-redirect">JS Redirect</a></li>
        <li><a href="/special/pdf-link">PDF Link</a></li>
        <li><a href="/special/download">File Download</a></li>
        <li><a href="/special/websocket">WebSocket</a></li>
        <li><a href="/special/xss-content">XSS Content</a></li>
        <li><a href="/special/unicode">Unicode Content</a></li>
        <li><a href="/special/base-tag">Base Tag</a></li>
        <li><a href="/special/anchor-links">Anchor Links</a></li>
        <li><a href="/special/dark-mode">Dark Mode Toggle</a></li>
      </ul>
    `));
  });

  // GET /about — Static page with landmarks
  app.get('/about', (_req: Request, res: Response) => {
    res.send(layout('About', `
      <h1>About Us</h1>
      <aside aria-label="Quick facts">
        <h2>Quick Facts</h2>
        <ul>
          <li>Founded: 2020</li>
          <li>Team size: 25</li>
          <li>Location: Remote-first</li>
        </ul>
      </aside>
      <section aria-label="Our Story">
        <h2>Our Story</h2>
        <p>We started this company to make web development more accessible. Our tools help developers understand and document complex web applications without requiring source code access.</p>
        <p>Our team brings decades of combined experience in browser automation, developer tooling, and software architecture.</p>
      </section>
      <section aria-label="Mission">
        <h2>Our Mission</h2>
        <p>To give every developer the power to understand any web application through runtime behavioral analysis.</p>
      </section>
      <a href="/">Back to Home</a>
    `));
  });

  // GET /contact — Page with headings hierarchy
  app.get('/contact', (_req: Request, res: Response) => {
    res.send(layout('Contact', `
      <h1>Contact Us</h1>
      <h2>General Inquiries</h2>
      <p>Email us at <a href="mailto:hello@example.com">hello@example.com</a></p>
      <h3>Business Hours</h3>
      <p>Monday through Friday, 9 AM to 5 PM EST.</p>
      <h2>Support</h2>
      <h3>Technical Support</h3>
      <p>For technical issues, please visit our <a href="https://github.com/example/issues">GitHub Issues</a> page.</p>
      <h4>Priority Support</h4>
      <p>Enterprise customers have access to priority support channels.</p>
      <h5>SLA Details</h5>
      <p>Response within 4 hours for critical issues.</p>
      <h6>Escalation Policy</h6>
      <p>Unresolved critical issues escalate to the engineering lead within 24 hours.</p>
      <h2>Office Location</h2>
      <p>123 Developer Lane, Suite 456, San Francisco, CA 94102</p>
      <a href="/">Back to Home</a>
    `));
  });

  // GET /team — Team member listing
  app.get('/team', (_req: Request, res: Response) => {
    const memberLinks = TEAM_MEMBERS.map(m =>
      `<div class="card">
        <h2><a href="/team/${m.id}">${m.name}</a></h2>
        <p><strong>${m.role}</strong></p>
        <p>${m.bio}</p>
      </div>`
    ).join('\n');
    res.send(layout('Team', `
      <h1>Our Team</h1>
      ${memberLinks}
      <a href="/">Back to Home</a>
    `));
  });

  // GET /team/:id — Individual team member
  app.get('/team/:id', (req: Request, res: Response) => {
    const member = TEAM_MEMBERS.find(m => m.id === parseInt(req.params.id, 10));
    if (!member) { res.status(404).send(layout('Not Found', '<h1>Team member not found</h1>')); return; }
    res.send(layout(member.name, `
      <h1>${member.name}</h1>
      <p><strong>Role:</strong> ${member.role}</p>
      <p>${member.bio}</p>
      <h2>Recent Contributions</h2>
      <ul>
        <li>Shipped the authentication module — Q1 2026</li>
        <li>Refactored the data pipeline — Q4 2025</li>
        <li>Led the migration to microservices — Q3 2025</li>
      </ul>
      <a href="/team">Back to Team</a>
    `));
  });

  // GET /blog — Blog listing with pagination
  app.get('/blog', (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const perPage = 3;
    const totalPages = Math.ceil(BLOG_POSTS.length / perPage);
    const start = (page - 1) * perPage;
    const posts = BLOG_POSTS.slice(start, start + perPage);

    const postCards = posts.map(p =>
      `<article class="card">
        <h2><a href="/blog/${p.slug}">${p.title}</a></h2>
        <time datetime="${p.date}">${p.date}</time>
        <p>${p.excerpt}</p>
      </article>`
    ).join('\n');

    const pagination = Array.from({ length: totalPages }, (_, i) => {
      const n = i + 1;
      return n === page
        ? `<span class="active">${n}</span>`
        : `<a href="/blog?page=${n}">${n}</a>`;
    }).join('\n');

    res.send(layout('Blog', `
      <h1>Blog</h1>
      ${postCards}
      <div class="pagination" aria-label="Blog pagination">
        ${page > 1 ? `<a href="/blog?page=${page - 1}">Previous</a>` : ''}
        ${pagination}
        ${page < totalPages ? `<a href="/blog?page=${page + 1}">Next</a>` : ''}
      </div>
      <a href="/">Back to Home</a>
    `));
  });

  // GET /blog/:slug — Individual blog post
  app.get('/blog/:slug', (req: Request, res: Response) => {
    const post = BLOG_POSTS.find(p => p.slug === req.params.slug);
    if (!post) { res.status(404).send(layout('Not Found', '<h1>Post not found</h1>')); return; }
    res.send(layout(post.title, `
      <article>
        <h1>${post.title}</h1>
        <time datetime="${post.date}">Published: ${post.date}</time>
        <p>${post.body}</p>
      </article>
      <nav aria-label="Post navigation">
        <a href="/blog">Back to Blog</a>
      </nav>
    `));
  });

  // GET /external-links — Page with links to external domains
  app.get('/external-links', (_req: Request, res: Response) => {
    res.send(layout('External Links', `
      <h1>External Links</h1>
      <p>These links point to external domains and should NOT be followed by a same-origin crawler.</p>
      <ul>
        <li><a href="https://github.com/example/repo" rel="noopener">GitHub Repository</a></li>
        <li><a href="https://docs.example.com/guide" rel="noopener">Documentation Site</a></li>
        <li><a href="https://status.example.com" rel="noopener">Status Page</a></li>
        <li><a href="https://cdn.example.com/asset.js" rel="noopener">CDN Resource</a></li>
        <li><a href="https://analytics.example.com" rel="noopener">Analytics Dashboard</a></li>
      </ul>
      <p>This link stays on the same origin: <a href="/about">About Us</a></p>
      <a href="/">Back to Home</a>
    `));
  });

  // =========================================================================
  // SPA SECTION (pushState-based navigation)
  // =========================================================================

  // SPA shell handler — shared by the root and all sub-routes so that
  // direct navigation to /spa/dashboard etc. returns the same HTML shell.
  // Client-side JS reads location.pathname to render the correct view.
  const serveSpaShell = (_req: Request, res: Response): void => {
    res.send(layout('SPA', `
      <h1>Single-Page Application</h1>
      <div id="spa-nav" role="navigation" aria-label="SPA navigation">
        <button class="btn" data-route="/spa/dashboard">Dashboard</button>
        <button class="btn" data-route="/spa/settings">Settings</button>
        <button class="btn" data-route="/spa/profile">Profile</button>
      </div>
      <div id="spa-content">
        <p>Click a button above to navigate. This section uses pushState for routing.</p>
      </div>
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          const content = document.getElementById('spa-content');
          const pages = {
            '/spa/dashboard': '<h2>Dashboard</h2><p>Welcome to your dashboard. You have 3 notifications and 12 pending tasks.</p><div class="card"><h3>Stats</h3><ul><li>Active users: 1,234</li><li>Revenue: $45,678</li><li>Uptime: 99.97%</li></ul></div>',
            '/spa/settings': '<h2>Settings</h2><form id="spa-settings-form"><div class="field"><label for="display-name">Display Name</label><input id="display-name" type="text" value="Test User"></div><div class="field"><label for="timezone">Timezone</label><select id="timezone"><option>UTC</option><option>EST</option><option>PST</option></select></div><button type="submit" class="btn">Save</button></form>',
            '/spa/profile': '<h2>Profile</h2><div class="card"><p><strong>Name:</strong> Test User</p><p><strong>Email:</strong> test@example.com</p><p><strong>Member since:</strong> January 2026</p></div><button class="btn" data-route="/spa/settings">Edit Profile</button>',
          };

          function navigate(path) {
            if (pages[path]) {
              history.pushState({ path }, '', path);
              content.innerHTML = pages[path];
              bindInternalNav();
            }
          }

          function bindInternalNav() {
            document.querySelectorAll('[data-route]').forEach(el => {
              el.addEventListener('click', (e) => {
                e.preventDefault();
                navigate(el.getAttribute('data-route'));
              });
            });
          }

          window.addEventListener('popstate', (e) => {
            if (e.state && e.state.path && pages[e.state.path]) {
              content.innerHTML = pages[e.state.path];
              bindInternalNav();
            }
          });

          bindInternalNav();

          // Handle direct navigation to SPA sub-routes
          const currentPath = window.location.pathname;
          if (pages[currentPath]) {
            content.innerHTML = pages[currentPath];
            bindInternalNav();
          }
        });
      </script>`
    }));
  };

  app.get('/spa', serveSpaShell);

  // Serve the SPA shell for sub-routes too (so direct navigation works)
  app.get('/spa/dashboard', serveSpaShell);
  app.get('/spa/settings', serveSpaShell);
  app.get('/spa/profile', serveSpaShell);

  // =========================================================================
  // HASH-ROUTED SECTION
  // =========================================================================

  app.get('/hash-app', (_req: Request, res: Response) => {
    res.send(layout('Hash App', `
      <h1>Hash-Routed Application</h1>
      <div role="navigation" aria-label="Hash navigation">
        <a href="#/home">Home</a>
        <a href="#/about">About</a>
        <a href="#/settings">Settings</a>
        <a href="#/profile">Profile</a>
      </div>
      <div id="hash-content">
        <p>This page uses hash-based routing. Click a link above.</p>
      </div>
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          const content = document.getElementById('hash-content');
          const routes = {
            '#/home': '<h2>Home</h2><p>Welcome to the hash-routed home page. This demonstrates legacy SPA routing.</p>',
            '#/about': '<h2>About</h2><p>This is the about section of the hash-routed app.</p><a href="#/home">Back to Hash Home</a>',
            '#/settings': '<h2>Settings</h2><div class="card"><p>Notification preferences, theme settings, and language options would go here.</p></div><a href="#/home">Back to Hash Home</a>',
            '#/profile': '<h2>Profile</h2><div class="card"><p><strong>Username:</strong> hashuser</p><p><strong>Plan:</strong> Free</p></div><a href="#/settings">Go to Settings</a>',
          };

          function render() {
            const hash = location.hash || '#/home';
            content.innerHTML = routes[hash] || '<h2>Not Found</h2><p>Unknown hash route.</p>';
          }

          window.addEventListener('hashchange', render);
          render();
        });
      </script>`
    }));
  });

  // =========================================================================
  // FORMS
  // =========================================================================

  // GET /forms/login
  app.get('/forms/login', (_req: Request, res: Response) => {
    res.send(layout('Login', `
      <h1>Login</h1>
      <form action="/auth/login" method="POST">
        <div class="field">
          <label for="email">Email Address</label>
          <input id="email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="8" autocomplete="current-password">
        </div>
        <div class="field">
          <label><input type="checkbox" name="remember" value="1"> Remember me</label>
        </div>
        <button type="submit" class="btn">Sign In</button>
      </form>
      <p>Don't have an account? <a href="/forms/register">Register here</a>.</p>
    `));
  });

  // GET /forms/register
  app.get('/forms/register', (_req: Request, res: Response) => {
    res.send(layout('Register', `
      <h1>Create Account</h1>
      <form action="/api/users" method="POST">
        <div class="field">
          <label for="reg-name">Full Name</label>
          <input id="reg-name" name="name" type="text" required placeholder="Jane Doe">
        </div>
        <div class="field">
          <label for="reg-email">Email</label>
          <input id="reg-email" name="email" type="email" required placeholder="jane@example.com">
        </div>
        <div class="field">
          <label for="reg-password">Password</label>
          <input id="reg-password" name="password" type="password" required minlength="8" pattern="(?=.*\\d)(?=.*[a-z])(?=.*[A-Z]).{8,}" title="Must contain at least one number, one uppercase and one lowercase letter, and at least 8 characters">
        </div>
        <div class="field">
          <label for="reg-role">Role</label>
          <select id="reg-role" name="role" required>
            <option value="">Select a role</option>
            <option value="developer">Developer</option>
            <option value="designer">Designer</option>
            <option value="manager">Manager</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="field">
          <label>Experience Level</label>
          <label><input type="radio" name="experience" value="junior" required> Junior (0-2 years)</label>
          <label><input type="radio" name="experience" value="mid"> Mid (3-5 years)</label>
          <label><input type="radio" name="experience" value="senior"> Senior (6+ years)</label>
        </div>
        <div class="field">
          <label><input type="checkbox" name="terms" required> I agree to the <a href="/about">Terms of Service</a></label>
        </div>
        <div class="field">
          <label><input type="checkbox" name="newsletter" value="1"> Subscribe to newsletter</label>
        </div>
        <button type="submit" class="btn">Create Account</button>
      </form>
    `));
  });

  // GET /forms/search
  app.get('/forms/search', (_req: Request, res: Response) => {
    const q = String(_req.query.q ?? '');
    const results = q
      ? BLOG_POSTS.filter(p => p.title.toLowerCase().includes(q.toLowerCase()) || p.body.toLowerCase().includes(q.toLowerCase()))
      : [];
    res.send(layout('Search', `
      <h1>Search</h1>
      <form action="/forms/search" method="GET" role="search">
        <div class="field" style="display:flex;gap:0.5rem;">
          <input name="q" type="search" placeholder="Search blog posts..." value="${q}" aria-label="Search query" style="flex:1;">
          <button type="submit" class="btn">Search</button>
        </div>
      </form>
      ${q ? `
        <h2>Results for "${q}"</h2>
        ${results.length > 0
          ? results.map(p => `<div class="card"><h3><a href="/blog/${p.slug}">${p.title}</a></h3><p>${p.excerpt}</p></div>`).join('')
          : '<p>No results found.</p>'}
      ` : ''}
    `));
  });

  // GET /forms/upload
  app.get('/forms/upload', (_req: Request, res: Response) => {
    res.send(layout('Upload', `
      <h1>File Upload</h1>
      <form action="/api/upload" method="POST" enctype="multipart/form-data">
        <div class="field">
          <label for="upload-title">Document Title</label>
          <input id="upload-title" name="title" type="text" required>
        </div>
        <div class="field">
          <label for="upload-file">File</label>
          <input id="upload-file" name="file" type="file" required accept=".pdf,.doc,.docx,.txt,.csv">
        </div>
        <div class="field">
          <label for="upload-desc">Description</label>
          <textarea id="upload-desc" name="description" rows="4" placeholder="Describe the document..."></textarea>
        </div>
        <button type="submit" class="btn">Upload Document</button>
      </form>
    `));
  });

  // GET /forms/multi-step
  app.get('/forms/multi-step', (_req: Request, res: Response) => {
    res.send(layout('Multi-Step Form', `
      <h1>Account Setup Wizard</h1>
      <div id="wizard">
        <div class="step active" data-step="1">
          <h2>Step 1: Personal Info</h2>
          <form id="step1-form">
            <div class="field">
              <label for="wiz-name">Full Name</label>
              <input id="wiz-name" name="name" type="text" required>
            </div>
            <div class="field">
              <label for="wiz-email">Email</label>
              <input id="wiz-email" name="email" type="email" required>
            </div>
            <button type="button" class="btn" data-next="2">Next</button>
          </form>
        </div>
        <div class="step" data-step="2" style="display:none;">
          <h2>Step 2: Preferences</h2>
          <form id="step2-form">
            <div class="field">
              <label for="wiz-lang">Preferred Language</label>
              <select id="wiz-lang" name="language">
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
              </select>
            </div>
            <div class="field">
              <label for="wiz-theme">Theme</label>
              <select id="wiz-theme" name="theme">
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </div>
            <button type="button" class="btn" data-prev="1">Back</button>
            <button type="button" class="btn" data-next="3">Next</button>
          </form>
        </div>
        <div class="step" data-step="3" style="display:none;">
          <h2>Step 3: Confirmation</h2>
          <p>Please review your information and click Finish to complete setup.</p>
          <div id="wiz-summary" class="card"></div>
          <button type="button" class="btn" data-prev="2">Back</button>
          <button type="button" class="btn" id="wiz-finish">Finish</button>
        </div>
      </div>
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          const steps = document.querySelectorAll('.step');
          function showStep(n) {
            steps.forEach(s => s.style.display = s.getAttribute('data-step') === String(n) ? 'block' : 'none');
          }
          document.querySelectorAll('[data-next]').forEach(btn => {
            btn.addEventListener('click', () => showStep(btn.getAttribute('data-next')));
          });
          document.querySelectorAll('[data-prev]').forEach(btn => {
            btn.addEventListener('click', () => showStep(btn.getAttribute('data-prev')));
          });
          document.getElementById('wiz-finish')?.addEventListener('click', () => {
            document.getElementById('wizard').innerHTML = '<div class="card"><h2>Setup Complete</h2><p>Your account has been configured successfully.</p><a href="/">Go to Home</a></div>';
          });
        });
      </script>`
    }));
  });

  // GET /forms/implicit — Inputs without <form> wrapper
  app.get('/forms/implicit', (_req: Request, res: Response) => {
    res.send(layout('Implicit Form', `
      <h1>Quick Feedback</h1>
      <p>This page has input fields but no wrapping &lt;form&gt; element.</p>
      <div class="card">
        <div class="field">
          <label for="imp-rating">Rating (1-5)</label>
          <input id="imp-rating" name="rating" type="number" min="1" max="5" placeholder="Rate us">
        </div>
        <div class="field">
          <label for="imp-comment">Comment</label>
          <textarea id="imp-comment" name="comment" rows="3" placeholder="Tell us what you think..."></textarea>
        </div>
        <button class="btn" id="imp-submit">Submit Feedback</button>
      </div>
      <div class="card" style="margin-top:2rem;">
        <h2>Newsletter Signup</h2>
        <div class="field" style="display:flex;gap:0.5rem;">
          <input name="newsletter-email" type="email" placeholder="your@email.com" aria-label="Newsletter email" style="flex:1;">
          <button class="btn">Subscribe</button>
        </div>
      </div>
    `));
  });

  // GET /forms/validation — HTML5 validation attributes
  app.get('/forms/validation', (_req: Request, res: Response) => {
    res.send(layout('Validation Form', `
      <h1>Form Validation</h1>
      <form action="/api/validate" method="POST" id="validation-form">
        <div class="field">
          <label for="val-name">Name (required, 2-50 chars)</label>
          <input id="val-name" name="name" type="text" required minlength="2" maxlength="50">
        </div>
        <div class="field">
          <label for="val-email">Email (required)</label>
          <input id="val-email" name="email" type="email" required>
        </div>
        <div class="field">
          <label for="val-age">Age (18-120)</label>
          <input id="val-age" name="age" type="number" min="18" max="120" required>
        </div>
        <div class="field">
          <label for="val-website">Website (URL pattern)</label>
          <input id="val-website" name="website" type="url" pattern="https://.*" placeholder="https://example.com" title="Must start with https://">
        </div>
        <div class="field">
          <label for="val-phone">Phone (US format)</label>
          <input id="val-phone" name="phone" type="tel" pattern="\\(\\d{3}\\) \\d{3}-\\d{4}" placeholder="(555) 123-4567" title="Format: (555) 123-4567">
        </div>
        <div class="field">
          <label for="val-date">Start Date (required)</label>
          <input id="val-date" name="start_date" type="date" required min="2026-01-01" max="2027-12-31">
        </div>
        <div class="field">
          <label for="val-color">Favorite Color</label>
          <input id="val-color" name="color" type="color" value="#0066cc">
        </div>
        <button type="submit" class="btn">Submit</button>
      </form>
    `));
  });

  // GET /forms/hidden-in-tab — Form inside a tab panel
  app.get('/forms/hidden-in-tab', (_req: Request, res: Response) => {
    res.send(layout('Hidden in Tab', `
      <h1>Tabbed Content</h1>
      <div class="tab-container">
        <div class="tab-buttons" role="tablist">
          <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="tab-info" data-tab="info">Info</button>
          <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-form" data-tab="form">Contact Form</button>
          <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-faq" data-tab="faq">FAQ</button>
        </div>
        <div id="tab-info" class="tab-panel active" role="tabpanel">
          <h2>Information</h2>
          <p>This tab contains general information. The contact form is hidden in the second tab.</p>
        </div>
        <div id="tab-form" class="tab-panel" role="tabpanel">
          <h2>Contact Form</h2>
          <form action="/api/contact" method="POST">
            <div class="field">
              <label for="tab-name">Your Name</label>
              <input id="tab-name" name="name" type="text" required>
            </div>
            <div class="field">
              <label for="tab-email">Your Email</label>
              <input id="tab-email" name="email" type="email" required>
            </div>
            <div class="field">
              <label for="tab-subject">Subject</label>
              <select id="tab-subject" name="subject">
                <option value="general">General Inquiry</option>
                <option value="support">Technical Support</option>
                <option value="billing">Billing</option>
                <option value="feedback">Feedback</option>
              </select>
            </div>
            <div class="field">
              <label for="tab-message">Message</label>
              <textarea id="tab-message" name="message" rows="5" required></textarea>
            </div>
            <button type="submit" class="btn">Send Message</button>
          </form>
        </div>
        <div id="tab-faq" class="tab-panel" role="tabpanel">
          <h2>Frequently Asked Questions</h2>
          <details>
            <summary>How do I reset my password?</summary>
            <p>Click the "Forgot Password" link on the login page and follow the instructions.</p>
          </details>
          <details>
            <summary>What browsers are supported?</summary>
            <p>Chrome, Firefox, Safari, and Edge (latest two versions).</p>
          </details>
        </div>
      </div>
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
              document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
              btn.classList.add('active');
              btn.setAttribute('aria-selected', 'true');
              document.getElementById('tab-' + btn.getAttribute('data-tab'))?.classList.add('active');
            });
          });
        });
      </script>`
    }));
  });

  // =========================================================================
  // API ENDPOINTS
  // =========================================================================

  // In-memory mutable copy for write operations
  let usersData = [...USERS_DB.map(u => ({ ...u }))];
  let nextUserId = usersData.length + 1;

  // GET /api/users
  app.get('/api/users', (_req: Request, res: Response) => {
    res.json({ data: usersData, total: usersData.length });
  });

  // GET /api/users/:id
  app.get('/api/users/:id', (req: Request, res: Response) => {
    const user = usersData.find(u => u.id === parseInt(req.params.id, 10));
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ data: user });
  });

  // POST /api/users
  app.post('/api/users', (req: Request, res: Response) => {
    const { name, email, role } = req.body;
    if (!name || !email) { res.status(400).json({ error: 'Name and email are required' }); return; }
    const user = { id: nextUserId++, name, email, role: role ?? 'viewer' };
    usersData.push(user);
    res.status(201).json({ data: user });
  });

  // PUT /api/users/:id
  app.put('/api/users/:id', (req: Request, res: Response) => {
    const idx = usersData.findIndex(u => u.id === parseInt(req.params.id, 10));
    if (idx === -1) { res.status(404).json({ error: 'User not found' }); return; }
    usersData[idx] = { ...usersData[idx], ...req.body, id: usersData[idx].id };
    res.json({ data: usersData[idx] });
  });

  // DELETE /api/users/:id
  app.delete('/api/users/:id', (req: Request, res: Response) => {
    const idx = usersData.findIndex(u => u.id === parseInt(req.params.id, 10));
    if (idx === -1) { res.status(404).json({ error: 'User not found' }); return; }
    const removed = usersData.splice(idx, 1)[0];
    res.json({ data: removed, deleted: true });
  });

  // GET /api/posts
  app.get('/api/posts', (_req: Request, res: Response) => {
    res.json({ data: POSTS_DB, total: POSTS_DB.length });
  });

  // GET /api/posts/:id
  app.get('/api/posts/:id', (req: Request, res: Response) => {
    const post = POSTS_DB.find(p => p.id === parseInt(req.params.id, 10));
    if (!post) { res.status(404).json({ error: 'Post not found' }); return; }
    res.json({ data: post });
  });

  // POST /graphql
  app.post('/graphql', (req: Request, res: Response) => {
    const { query, variables } = req.body;
    if (!query) { res.status(400).json({ errors: [{ message: 'Query is required' }] }); return; }

    const trimmed = query.replace(/\s+/g, ' ').trim();

    // query { users { id name } }
    if (trimmed.includes('users') && !trimmed.includes('user(')) {
      res.json({ data: { users: usersData.map(u => ({ id: u.id, name: u.name })) } });
      return;
    }

    // query { user(id: N) { id name email } }
    const userMatch = trimmed.match(/user\s*\(\s*id\s*:\s*(\d+)\s*\)/);
    if (userMatch) {
      const id = parseInt(userMatch[1], 10);
      const resolvedId = variables?.id ?? id;
      const user = usersData.find(u => u.id === resolvedId);
      if (!user) { res.json({ data: { user: null }, errors: [{ message: 'User not found' }] }); return; }
      res.json({ data: { user: { id: user.id, name: user.name, email: user.email } } });
      return;
    }

    // mutation { createUser(name: "Test") { id } }
    const createMatch = trimmed.match(/createUser\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/);
    if (createMatch) {
      const name = variables?.name ?? createMatch[1];
      const user = { id: nextUserId++, name, email: `${name.toLowerCase().replace(/\s/g, '.')}@example.com`, role: 'viewer' as const };
      usersData.push(user);
      res.json({ data: { createUser: { id: user.id } } });
      return;
    }

    res.status(400).json({ errors: [{ message: 'Unrecognized query' }] });
  });

  // POST /api/upload — stub for file upload testing
  app.post('/api/upload', (_req: Request, res: Response) => {
    res.status(201).json({ data: { id: randomUUID(), status: 'uploaded' } });
  });

  // POST /api/validate — stub for form validation testing
  app.post('/api/validate', (req: Request, res: Response) => {
    res.json({ data: { valid: true, received: req.body } });
  });

  // POST /api/contact — stub for contact form
  app.post('/api/contact', (req: Request, res: Response) => {
    res.json({ data: { id: randomUUID(), status: 'received', ...req.body } });
  });

  // =========================================================================
  // AUTH SECTION
  // =========================================================================

  // Simple cookie-based session (no real session store)
  function isAuthenticated(req: Request): boolean {
    const cookie = req.headers.cookie ?? '';
    return cookie.includes(`session=${SESSION_TOKEN}`);
  }

  // POST /auth/login
  app.post('/auth/login', (req: Request, res: Response) => {
    const { email, password } = req.body;
    if (email === AUTH_CREDENTIALS.email && password === AUTH_CREDENTIALS.password) {
      res.setHeader('Set-Cookie', `session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
      res.json({ success: true, redirect: '/protected/dashboard' });
    } else {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
  });

  // GET /auth/logout
  app.get('/auth/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/forms/login');
  });

  // Protected routes middleware
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!isAuthenticated(req)) {
      if (req.headers.accept?.includes('application/json')) {
        res.status(401).json({ error: 'Unauthorized' });
      } else {
        res.status(401).send(layout('Unauthorized', `
          <h1>401 — Unauthorized</h1>
          <p>You must be logged in to view this page.</p>
          <a href="/forms/login" class="btn">Go to Login</a>
        `));
      }
      return;
    }
    next();
  }

  // GET /protected
  app.get('/protected', requireAuth, (_req: Request, res: Response) => {
    res.send(layout('Protected', `
      <h1>Protected Area</h1>
      <p>Welcome! You are authenticated.</p>
      <ul>
        <li><a href="/protected/dashboard">Dashboard</a></li>
        <li><a href="/protected/settings">Settings</a></li>
      </ul>
      <a href="/auth/logout">Logout</a>
    `));
  });

  // GET /protected/dashboard
  app.get('/protected/dashboard', requireAuth, (_req: Request, res: Response) => {
    res.send(layout('Dashboard', `
      <h1>Dashboard</h1>
      <div class="card">
        <h2>Overview</h2>
        <table>
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Total Users</td><td>${usersData.length}</td></tr>
            <tr><td>Active Sessions</td><td>42</td></tr>
            <tr><td>API Calls Today</td><td>1,337</td></tr>
            <tr><td>Error Rate</td><td>0.02%</td></tr>
          </tbody>
        </table>
      </div>
      <a href="/protected">Back to Protected Area</a>
      <a href="/auth/logout">Logout</a>
    `));
  });

  // GET /protected/settings
  app.get('/protected/settings', requireAuth, (_req: Request, res: Response) => {
    res.send(layout('Settings', `
      <h1>Account Settings</h1>
      <form action="/api/settings" method="POST">
        <div class="field">
          <label for="set-name">Display Name</label>
          <input id="set-name" name="display_name" type="text" value="Admin User">
        </div>
        <div class="field">
          <label for="set-email">Email</label>
          <input id="set-email" name="email" type="email" value="${AUTH_CREDENTIALS.email}">
        </div>
        <div class="field">
          <label><input type="checkbox" name="notifications" checked> Email notifications</label>
        </div>
        <button type="submit" class="btn">Save Settings</button>
      </form>
      <a href="/protected">Back to Protected Area</a>
      <a href="/auth/logout">Logout</a>
    `));
  });

  // =========================================================================
  // ERROR PAGES
  // =========================================================================

  // GET /error/404
  app.get('/error/404', (_req: Request, res: Response) => {
    res.status(404).send(layout('Not Found', `
      <h1>404 — Page Not Found</h1>
      <p>The requested page does not exist.</p>
      <a href="/">Go to Home</a>
    `));
  });

  // GET /error/500
  app.get('/error/500', (_req: Request, res: Response) => {
    res.status(500).send(layout('Server Error', `
      <h1>500 — Internal Server Error</h1>
      <p>Something went wrong on our end. Please try again later.</p>
      <a href="/">Go to Home</a>
    `));
  });

  // GET /error/timeout — 60 second delay
  app.get('/error/timeout', (_req: Request, res: Response) => {
    // Hold the response open for 60 seconds
    const timer = setTimeout(() => {
      res.send(layout('Timeout', '<h1>This page took a long time</h1>'));
    }, 60_000);
    // Clean up if client disconnects
    res.on('close', () => clearTimeout(timer));
  });

  // GET /error/redirect-loop — infinite redirect
  app.get('/error/redirect-loop', (_req: Request, res: Response) => {
    res.redirect(301, '/error/redirect-loop-b');
  });
  app.get('/error/redirect-loop-b', (_req: Request, res: Response) => {
    res.redirect(301, '/error/redirect-loop');
  });

  // GET /error/redirect-chain — 301 -> 302 -> 303 -> 200
  app.get('/error/redirect-chain', (_req: Request, res: Response) => {
    res.redirect(301, '/error/redirect-chain-2');
  });
  app.get('/error/redirect-chain-2', (_req: Request, res: Response) => {
    res.redirect(302, '/error/redirect-chain-3');
  });
  app.get('/error/redirect-chain-3', (_req: Request, res: Response) => {
    res.redirect(303, '/error/redirect-chain-final');
  });
  app.get('/error/redirect-chain-final', (_req: Request, res: Response) => {
    res.send(layout('Redirect Complete', `
      <h1>Redirect Chain Complete</h1>
      <p>You arrived here after a 301 -> 302 -> 303 redirect chain.</p>
      <a href="/">Go to Home</a>
    `));
  });

  // =========================================================================
  // SPECIAL CASES
  // =========================================================================

  // GET /special/dialog — Page that shows alert() on load
  app.get('/special/dialog', (_req: Request, res: Response) => {
    res.send(layout('Dialog', `
      <h1>Dialog Test</h1>
      <p>An alert dialog should have appeared on page load.</p>
      <button class="btn" onclick="confirm('Are you sure?')">Show Confirm</button>
      <button class="btn" onclick="prompt('Enter your name:')">Show Prompt</button>
    `, {
      head: `<script>
        window.addEventListener('load', () => { alert('Welcome to the dialog test page!'); });
      </script>`
    }));
  });

  // GET /special/popup — Page that opens window.open() on load
  app.get('/special/popup', (_req: Request, res: Response) => {
    res.send(layout('Popup', `
      <h1>Popup Test</h1>
      <p>A popup window should have been attempted on page load.</p>
      <p>Most browsers and Playwright block unsolicited popups by default.</p>
      <button class="btn" onclick="window.open('/about', '_blank', 'width=400,height=300')">Open Popup Manually</button>
    `, {
      head: `<script>
        window.addEventListener('load', () => {
          window.open('/about', 'popup', 'width=400,height=300');
        });
      </script>`
    }));
  });

  // GET /special/slow — Page that takes 5 seconds to fully load
  app.get('/special/slow', (_req: Request, res: Response) => {
    res.send(layout('Slow Page', `
      <h1>Slow Loading Page</h1>
      <p>Initial content loads immediately.</p>
      <div id="slow-content">Loading additional content...</div>
    `, {
      head: `<script>
        window.addEventListener('load', () => {
          setTimeout(() => {
            document.getElementById('slow-content').innerHTML = '<div class="card"><h2>Content Loaded</h2><p>This content appeared after a 5-second delay. It simulates lazy-loaded API data or heavy computation.</p><ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul></div>';
          }, 5000);
        });
      </script>`
    }));
  });

  // GET /special/large-dom — Page with 1000+ elements
  app.get('/special/large-dom', (_req: Request, res: Response) => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      `<tr><td>${i + 1}</td><td>Item ${i + 1}</td><td>Description for item ${i + 1} with enough text to be realistic.</td><td>Category ${(i % 5) + 1}</td><td>$${((i + 1) * 9.99).toFixed(2)}</td></tr>`
    ).join('\n');

    const cards = Array.from({ length: 200 }, (_, i) =>
      `<div class="card"><h3>Card ${i + 1}</h3><p>This is content for card number ${i + 1}. It contains a <a href="/team/${(i % 4) + 1}">link to a team member</a> and some <strong>bold text</strong>.</p><button class="btn">Action ${i + 1}</button></div>`
    ).join('\n');

    res.send(layout('Large DOM', `
      <h1>Large DOM Test</h1>
      <p>This page contains 1000+ DOM elements to test crawler performance.</p>
      <h2>Data Table (250 rows, 1250 cells)</h2>
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Description</th><th>Category</th><th>Price</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h2>Card Grid (200 cards)</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;">
        ${cards}
      </div>
    `));
  });

  // GET /special/lazy-load — Intersection observer lazy loading
  app.get('/special/lazy-load', (_req: Request, res: Response) => {
    const placeholders = Array.from({ length: 20 }, (_, i) =>
      `<div class="lazy-item card" data-index="${i}" style="min-height:200px;">
        <p>Lazy item ${i + 1} — content not loaded yet.</p>
      </div>`
    ).join('\n');

    res.send(layout('Lazy Load', `
      <h1>Lazy Load Test</h1>
      <p>Scroll down to trigger intersection observer loading.</p>
      ${placeholders}
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              if (entry.isIntersecting) {
                const el = entry.target;
                const idx = el.getAttribute('data-index');
                el.innerHTML = '<h3>Loaded Item ' + (parseInt(idx) + 1) + '</h3><p>This content was loaded when the element scrolled into view. It contains a <a href="/blog/' + ['getting-started','advanced-patterns','performance-tuning'][idx % 3] + '">link to a blog post</a>.</p>';
                el.style.background = '#f0f8ff';
                observer.unobserve(el);
              }
            });
          }, { threshold: 0.1 });

          document.querySelectorAll('.lazy-item').forEach(el => observer.observe(el));
        });
      </script>`
    }));
  });

  // GET /special/iframe — Same-origin iframe
  app.get('/special/iframe', (_req: Request, res: Response) => {
    res.send(layout('iFrame Test', `
      <h1>Same-Origin iFrame</h1>
      <p>The iframe below loads a page from the same origin.</p>
      <iframe src="/special/iframe-content" width="100%" height="400" style="border:1px solid #ddd;border-radius:8px;" title="Embedded content"></iframe>
      <p><a href="/">Back to Home</a></p>
    `));
  });

  // Content served inside the iframe
  app.get('/special/iframe-content', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>iFrame Content</title>
<style>body{font-family:sans-serif;padding:1rem;margin:0;background:#f8f8ff;}</style>
</head>
<body>
  <h2>Embedded Content</h2>
  <p>This content is inside a same-origin iframe.</p>
  <ul>
    <li><a href="/about">About (same origin)</a></li>
    <li><a href="/contact">Contact (same origin)</a></li>
  </ul>
  <form action="/api/contact" method="POST">
    <label for="iframe-msg">Message from iframe:</label>
    <input id="iframe-msg" name="message" type="text" placeholder="Hello from iframe">
    <button type="submit">Send</button>
  </form>
</body>
</html>`);
  });

  // GET /special/iframe-external — Cross-origin iframe
  app.get('/special/iframe-external', (_req: Request, res: Response) => {
    res.send(layout('External iFrame', `
      <h1>Cross-Origin iFrame</h1>
      <p>The iframe below references an external domain. The crawler should record but not crawl it.</p>
      <iframe src="https://example.com" width="100%" height="400" style="border:1px solid #ddd;border-radius:8px;" title="External content" sandbox="allow-scripts"></iframe>
      <p><a href="/">Back to Home</a></p>
    `));
  });

  // GET /special/meta-refresh — Meta refresh redirect
  app.get('/special/meta-refresh', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="3;url=/about">
  <title>Meta Refresh — Test App</title>
</head>
<body>
  <h1>Meta Refresh</h1>
  <p>This page will redirect to <a href="/about">/about</a> in 3 seconds via meta refresh.</p>
</body>
</html>`);
  });

  // GET /special/js-redirect — JavaScript redirect
  app.get('/special/js-redirect', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>JS Redirect — Test App</title>
</head>
<body>
  <h1>JavaScript Redirect</h1>
  <p>This page will redirect via JavaScript in 1 second.</p>
  <script>
    setTimeout(() => { window.location.href = '/contact'; }, 1000);
  </script>
</body>
</html>`);
  });

  // GET /special/pdf-link — Page with a link to a PDF file
  app.get('/special/pdf-link', (_req: Request, res: Response) => {
    res.send(layout('PDF Link', `
      <h1>Documents</h1>
      <ul>
        <li><a href="/static/sample.pdf">Download Sample PDF</a></li>
        <li><a href="/about">About (HTML page)</a></li>
      </ul>
    `));
  });

  // Serve a minimal PDF
  app.get('/static/sample.pdf', (_req: Request, res: Response) => {
    // Minimal valid PDF
    const pdf = `%PDF-1.0
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
206
%%EOF`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="sample.pdf"');
    res.send(pdf);
  });

  // GET /special/download — File download trigger
  app.get('/special/download', (_req: Request, res: Response) => {
    res.send(layout('Download', `
      <h1>File Download</h1>
      <p>Clicking the link below triggers a file download.</p>
      <a href="/static/report.csv" download="report.csv" class="btn">Download CSV Report</a>
      <a href="/">Back to Home</a>
    `));
  });

  app.get('/static/report.csv', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
    res.send('id,name,value\n1,Alpha,100\n2,Beta,200\n3,Gamma,300\n');
  });

  // GET /special/websocket — WebSocket page
  app.get('/special/websocket', (_req: Request, res: Response) => {
    res.send(layout('WebSocket', `
      <h1>WebSocket Test</h1>
      <div id="ws-status" class="card">Connecting...</div>
      <div id="ws-messages"></div>
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          const status = document.getElementById('ws-status');
          const messages = document.getElementById('ws-messages');
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(protocol + '//' + location.host + '/ws');
          ws.onopen = () => { status.textContent = 'Connected'; ws.send(JSON.stringify({ type: 'ping' })); };
          ws.onmessage = (e) => {
            const div = document.createElement('div');
            div.className = 'card';
            div.textContent = 'Received: ' + e.data;
            messages.appendChild(div);
          };
          ws.onclose = () => { status.textContent = 'Disconnected'; };
          ws.onerror = () => { status.textContent = 'Error'; };
        });
      </script>`
    }));
  });

  // GET /special/xss-content — Content with <script> tags in text
  app.get('/special/xss-content', (_req: Request, res: Response) => {
    // Deliberately includes content that would be XSS if rendered unescaped
    // The server renders it safely; this tests the crawler's report escaping
    const dangerousUserContent = '&lt;script&gt;alert("xss")&lt;/script&gt;';
    const dangerousAttr = '&quot; onmouseover=&quot;alert(1)';
    res.send(layout('XSS Content', `
      <h1>XSS Test Content</h1>
      <p>This page contains text that resembles XSS payloads. The crawler's report must escape this data.</p>
      <div class="card">
        <h2>User-Generated Content Examples</h2>
        <p>User comment: ${dangerousUserContent}</p>
        <p>Username: ${dangerousAttr}</p>
        <p>Another payload: &lt;img src=x onerror=alert(1)&gt;</p>
        <p>SVG payload: &lt;svg onload=alert(1)&gt;</p>
      </div>
      <div class="card">
        <h2>Data Attribute</h2>
        <div data-user-input="test&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">This div has a data attribute with suspicious content.</div>
      </div>
    `));
  });

  // GET /special/unicode — Unicode content and URLs
  app.get('/special/unicode', (_req: Request, res: Response) => {
    res.send(layout('Unicode', `
      <h1>Unicode Content Test</h1>
      <h2>Multilingual Text</h2>
      <ul>
        <li>Japanese: \u3053\u3093\u306B\u3061\u306F\u4E16\u754C (Hello World)</li>
        <li>Arabic: \u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645</li>
        <li>Russian: \u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440</li>
        <li>Korean: \uC548\uB155\uD558\uC138\uC694 \uC138\uACC4</li>
        <li>Emoji: \uD83D\uDE80\uD83C\uDF0D\uD83D\uDC68\u200D\uD83D\uDCBB\uD83E\uDDE9</li>
      </ul>
      <h2>Unicode in URLs</h2>
      <ul>
        <li><a href="/special/unicode/caf%C3%A9">Caf\u00E9 (encoded)</a></li>
        <li><a href="/special/unicode/\u00FCber">\u00DCber (raw UTF-8)</a></li>
      </ul>
      <h2>Special Characters</h2>
      <p>Curly quotes: \u201CHello\u201D \u2018World\u2019</p>
      <p>Em dash: text \u2014 more text</p>
      <p>Ellipsis: wait\u2026</p>
      <p>Copyright: \u00A9 2026</p>
    `));
  });

  // Serve unicode sub-routes
  app.get('/special/unicode/:word', (req: Request, res: Response) => {
    res.send(layout('Unicode Page', `
      <h1>Unicode Route: ${req.params.word}</h1>
      <p>This page was reached via a URL containing non-ASCII characters.</p>
      <a href="/special/unicode">Back to Unicode</a>
    `));
  });

  // GET /special/base-tag — Page with <base> tag
  app.get('/special/base-tag', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <base href="/blog/">
  <title>Base Tag Test — Test App</title>
  <style>body{font-family:sans-serif;padding:2rem;}</style>
</head>
<body>
  <h1>Base Tag Test</h1>
  <p>This page has <code>&lt;base href="/blog/"&gt;</code>. All relative links resolve against /blog/.</p>
  <ul>
    <li><a href="getting-started">Getting Started</a> (resolves to /blog/getting-started)</li>
    <li><a href="advanced-patterns">Advanced Patterns</a> (resolves to /blog/advanced-patterns)</li>
    <li><a href="/about">About</a> (absolute, unaffected by base)</li>
  </ul>
</body>
</html>`);
  });

  // GET /special/anchor-links — Same-page anchor links
  app.get('/special/anchor-links', (_req: Request, res: Response) => {
    res.send(layout('Anchor Links', `
      <h1>Same-Page Anchor Links</h1>
      <nav aria-label="Page sections">
        <a href="#section1">Section 1</a> |
        <a href="#section2">Section 2</a> |
        <a href="#section3">Section 3</a> |
        <a href="#top">Back to Top</a>
      </nav>
      <div id="top"></div>
      <section id="section1" style="margin-top:2rem;">
        <h2>Section 1: Introduction</h2>
        <p>This is the first section of the page. Anchor links like these should NOT be treated as separate pages by the crawler.</p>
        <p>They should be recognized as same-page navigation.</p>
      </section>
      <section id="section2" style="margin-top:2rem;">
        <h2>Section 2: Details</h2>
        <p>This is the second section with more detailed content. It demonstrates how real-world pages use anchor links for long-form content.</p>
      </section>
      <section id="section3" style="margin-top:2rem;">
        <h2>Section 3: Conclusion</h2>
        <p>The final section wraps up the content. Note how these anchors differ from hash-based routing (which uses #/path patterns).</p>
      </section>
      <a href="/">Back to Home</a>
    `));
  });

  // GET /special/dark-mode — Dark/light theme toggle
  app.get('/special/dark-mode', (_req: Request, res: Response) => {
    res.send(layout('Dark Mode', `
      <h1>Theme Toggle</h1>
      <button class="btn" id="theme-toggle">Toggle Dark Mode</button>
      <div class="card" style="margin-top:1rem;">
        <h2>Content Preview</h2>
        <p>This card shows how content appears in the current theme mode.</p>
        <p>The toggle button switches between light and dark themes by adding a CSS class to the body.</p>
      </div>
    `, {
      head: `<script>
        document.addEventListener('DOMContentLoaded', () => {
          const btn = document.getElementById('theme-toggle');
          btn.addEventListener('click', () => {
            document.body.classList.toggle('dark-mode');
            btn.textContent = document.body.classList.contains('dark-mode')
              ? 'Switch to Light Mode'
              : 'Toggle Dark Mode';
          });
        });
      </script>`
    }));
  });

  // =========================================================================
  // STATIC ASSETS
  // =========================================================================

  app.get('/static/style.css', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/css');
    res.send(`
      /* Test App Stylesheet */
      .highlight { background: #fff3cd; padding: 0.25rem 0.5rem; border-radius: 4px; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    `);
  });

  app.get('/static/logo.svg', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <rect width="120" height="120" rx="16" fill="#1a1a2e"/>
      <text x="60" y="70" text-anchor="middle" fill="#e0e0ff" font-family="sans-serif" font-size="48" font-weight="bold">PA</text>
    </svg>`);
  });

  // =========================================================================
  // API - settings stub (for protected settings form)
  // =========================================================================

  app.post('/api/settings', (req: Request, res: Response) => {
    res.json({ data: { updated: true, ...req.body } });
  });

  // =========================================================================
  // RESET endpoint — for test isolation
  // =========================================================================

  app.post('/__reset', (_req: Request, res: Response) => {
    usersData = [...USERS_DB.map(u => ({ ...u }))];
    nextUserId = usersData.length + 1;
    res.json({ reset: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Server factory (used by setup.ts and standalone execution)
// ---------------------------------------------------------------------------

export interface TestServer {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export function startServer(app: express.Express, port: number = 0): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);

    // WebSocket server on the same HTTP server
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          } else {
            ws.send(JSON.stringify({ type: 'echo', data: msg }));
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });
      // Send a welcome message
      ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to test WebSocket server' }));
    });

    server.on('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const resolvedPort = addr.port;
      const url = `http://127.0.0.1:${resolvedPort}`;

      const closeServer = (): Promise<void> => {
        return new Promise((res, rej) => {
          // Close all WebSocket connections
          wss.clients.forEach(client => client.terminate());
          wss.close();
          server.close((err) => {
            if (err) rej(err);
            else res();
          });
        });
      };

      resolve({ url, port: resolvedPort, server, close: closeServer });
    });
  });
}

// ---------------------------------------------------------------------------
// Standalone execution (for manual testing: npx tsx test/fixtures/test-app/server.ts)
// ---------------------------------------------------------------------------

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('server.ts') ||
  process.argv[1].endsWith('server.js')
);

if (isMainModule) {
  const port = parseInt(process.env.PORT ?? '3456', 10);
  const app = createTestApp();
  startServer(app, port).then(({ url }) => {
    console.log(`Test app running at ${url}`);
    console.log('Press Ctrl+C to stop');
  });
}
