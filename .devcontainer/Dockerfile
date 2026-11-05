# Node.js 24 LTS matches the Lambda runtime (nodejs24.x), so local and cloud behave the same.
FROM mcr.microsoft.com/devcontainers/typescript-node:3-24-bookworm

# AWS CLI v2 (official installer, picks the right CPU architecture)
RUN apt-get update && apt-get install -y --no-install-recommends unzip jq \
    && ARCH="$(uname -m)" \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# bubblewrap and socat back the sandbox that Claude Code and Copilot use to run commands on Linux:
# bubblewrap isolates each command in its own namespaces, socat proxies its network traffic.
# bubblewrap also needs the seccomp=unconfined runArg in devcontainer.json to create namespaces.
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# AWS CDK CLI for running `cdk` directly. Must match the aws-cdk devDependency in package.json
# (npx cdk uses that one); bump both together.
RUN npm install -g aws-cdk@2.1147.0

# Claude Code CLI, so the AI assistant runs inside this container and only sees the mounted repo,
# not the rest of the host machine.
RUN npm install -g @anthropic-ai/claude-code

# Pre-create the config dir owned by 'node'. Otherwise Docker creates the mounted volume
# as root-owned and Claude Code can't save its login.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude

USER node
