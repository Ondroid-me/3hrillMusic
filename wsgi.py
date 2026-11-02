from pulse import app, start_background

# Start the auto-scrape loop as soon as the server boots,
# instead of waiting for the first visitor request.
start_background()

if __name__ == "__main__":
    app.run()
