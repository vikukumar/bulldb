FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt pyproject.toml ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run pytest on build check
CMD ["pytest"]
