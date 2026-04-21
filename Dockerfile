# Build a container that runs `pa` against an external URL.
#
# Usage:
#   docker build -t pa .
#   docker run --rm -v "$PWD/out:/work" pa dig https://example.com -o /work
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

RUN useradd --create-home --shell /bin/bash pa \
    && mkdir /work \
    && chown pa /work

USER pa
WORKDIR /work

RUN npm install -g playwright-archaeologist@0.1.1

ENTRYPOINT ["pa"]
CMD ["--help"]
