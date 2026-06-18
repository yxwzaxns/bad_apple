FROM golang:1.23-bookworm AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /badapple ./cmd/badapple

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /badapple /badapple

ENV PORT=7860
EXPOSE 7860

ENTRYPOINT ["/badapple", "serve"]
