# pixel2mqtt - standard library only, no pip packages
FROM python:3.12-alpine
WORKDIR /app
COPY pixel2mqtt ./pixel2mqtt
ENV PIXEL2MQTT_DATA=/app/data PYTHONUNBUFFERED=1
VOLUME /app/data
EXPOSE 8466
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:${WEB_PORT:-8466}/api/status > /dev/null || exit 1
CMD ["python", "-m", "pixel2mqtt"]
