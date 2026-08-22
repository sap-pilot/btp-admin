#!/bin/bash
# Build btp-admin-sidecar.war for deployment to SAP Java Buildpack (TomEE runtime).
# Requires sapjco3.jar in ../server/sapjco3/ (not committed — copy from SAP Service Marketplace).
# Run from sidecar/ directory or via the repo root.
set -e
cd "$(dirname "$0")"

SERVLET_JAR="jakarta.servlet-api-5.0.0.jar"
JCO_JAR="sapjco3.jar"
WAR="btp-admin-sidecar.war"

if [ ! -f "$SERVLET_JAR" ]; then
    echo "Downloading $SERVLET_JAR from Maven Central..."
    curl -fsSL "https://repo1.maven.org/maven2/jakarta/servlet/jakarta.servlet-api/5.0.0/jakarta.servlet-api-5.0.0.jar" \
         -o "$SERVLET_JAR"
fi

if [ ! -f "$JCO_JAR" ]; then
    echo "ERROR: $JCO_JAR not found."
    echo "Copy sapjco3.jar to sidecar/ (from SAP Software Center / NW RFC SDK)."
    exit 1
fi

rm -rf WEB-INF/classes
mkdir -p WEB-INF/classes META-INF
javac -cp "$SERVLET_JAR:$JCO_JAR" -source 11 -target 11 \
      -d WEB-INF/classes \
      SidecarServlet.java
echo "Compiled SidecarServlet"

jar cvf "$WAR" WEB-INF/ META-INF/
echo "Built: $WAR ($(du -h "$WAR" | cut -f1))"
echo ""
echo "Deploy with:  cf push -f manifest.yml"
