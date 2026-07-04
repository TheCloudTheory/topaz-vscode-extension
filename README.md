# Topaz - VS Code Extension

Explore and manage [Topaz](https://topaz.thecloudtheory.com/) resources directly from VS Code.

## Prerequisites

Topaz must be running in the background before using this extension. Start it using one of the following methods:

```bash
# macOS
brew tap thecloudtheory/topaz && brew install topaz && topaz-host

# Linux
curl -fsSL https://raw.githubusercontent.com/TheCloudTheory/Topaz/main/install/get-topaz.sh | bash

# Docker (latest stable release)
docker run -p 8899:8899 thecloudtheory/topaz-host

# Docker (nightly — built daily from main)
docker run -p 8899:8899 thecloudtheory/topaz-host:nightly
```

By default, the extension connects to `https://topaz.local.dev:8899`. You can change this in VS Code settings under **Topaz > Base URL**.

## Features

- Browse Topaz resources grouped by resource group
- Browse resources by service type
- Refresh resource views on demand
