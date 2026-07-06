# Topaz - VS Code Extension

Explore and manage [Topaz](https://topaz.thecloudtheory.com/) resources directly from VS Code.

## What is Topaz?

[Topaz](https://topaz.thecloudtheory.com/) is a single-binary Azure emulator. Instead of running Azurite for Storage, a separate emulator for Service Bus, and another for Key Vault — you run one tool. It supports both the control and data planes of Azure services, emulates ARM deployments with Bicep and ARM Templates, and implements Azure RBAC, all locally with no Azure subscription required.

This extension lets you browse and manage Topaz resources (resource groups, storage accounts, Service Bus namespaces, and more) directly from the VS Code sidebar — without leaving your editor. You can also manage the emulator itself: monitor its health, version, and running mode, and create Azure resource hierarchy objects such as management groups, subscriptions, and resource groups directly from the sidebar.

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

- Browse resources grouped by resource group or by service type
- Create management groups, subscriptions, and resource groups
- Monitor emulator status: health, version, and running mode
- Refresh resource views on demand
