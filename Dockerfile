# ---- 1. build the Angular PWA
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build --configuration production

# ---- 2. build the ASP.NET Core API
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS api
WORKDIR /src
COPY database/ database/
COPY backend/ backend/
RUN dotnet publish backend/SpiceErp.Api/SpiceErp.Api.csproj -c Release -o /app

# ---- 3. runtime: API serves the PWA from wwwroot (same origin, no CORS needed)
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=api /app ./
COPY --from=web /web/dist/frontend/browser ./wwwroot
ENV ASPNETCORE_URLS=http://+:8080 Uploads__Path=/data/uploads
RUN mkdir -p /data/uploads && chown app /data/uploads
VOLUME /data/uploads
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "SpiceErp.Api.dll"]
