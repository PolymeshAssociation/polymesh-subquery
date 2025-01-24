#!/bin/bash

# Get the latest tag
TAG_NAME=$(git describe --tags --abbrev=0)

# Strip the 'v' prefix if it exists
VERSION=${TAG_NAME#v}


# Update the version field in package.json
jq --arg version "$VERSION" '.version = $version' package.json > tmp.json && mv tmp.json package.json

echo "Updated package.json version to $VERSION"