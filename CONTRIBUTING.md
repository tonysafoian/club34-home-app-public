# Contributing to Household OS

Thank you for your interest in contributing to Household OS! We welcome contributions, bug reports, and suggestions from the community.

## Development Workflow

1. **Fork the Repository** on GitHub.
2. **Clone your fork locally**:
   ```bash
   git clone https://github.com/<your-username>/club34-home-app-public.git
   cd club34-home-app-public
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Create a feature branch**:
   ```bash
   git checkout -b feature/my-new-feature
   ```
5. **Set up your local environment**:
   ```bash
   cp .env.example .env
   # Configure DATABASE_URL and desired service keys
   ```
6. **Test your changes**:
   ```bash
   npm run check
   npm test
   ```
7. **Commit & Push**:
   ```bash
   git commit -m "feat: add support for new thermostat provider"
   git push origin feature/my-new-feature
   ```
8. **Open a Pull Request** against `main`.

## Security

Please do not commit personal credentials, API keys, or private household addresses. All device credentials must be passed via environment variables.
