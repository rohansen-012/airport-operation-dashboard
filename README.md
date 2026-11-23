# Airport Operation Dashboard

A real-time style operations dashboard for Indira Gandhi International Airport, New Delhi (DEL), written as one HTML file with no dependencies.

> **Unofficial demo.** This project is not affiliated with Delhi International Airport Ltd (DIAL), AAI or any airline. Every number comes from a built-in simulation of a typical DEL day; none of it is live data.

## What's on it

- **Animated airfield map:** all four runways, Terminals 1, 2 and 3, cargo, the Eastern Cross Taxiway, the tower, fire stations and the fuel farm. Aircraft fly the approach, land, taxi, park, push back and take off. Hover over an aircraft to see its speed and altitude; click it to follow it.
- **Headline numbers:** passengers in the terminals, flights today, flights in the last hour against capacity, on-time %, security wait, planes on stands, bags, cargo and weather.
- **Arrivals and departures boards** with live status.
- **Runway status**, an **operations event log**, **hourly flight** and **passengers-in-terminal** charts.
- **Terminal queues** (check-in, security, immigration, baggage belts).
- **Aircraft turnarounds:** each parked plane's progress through cleaning, catering, fuelling, bags and boarding.
- **Background systems:** baggage, fuel, power, fire and rescue, lighting, bird hazard, runway inspection, cargo and the metro line.
- **Scenario buttons:** 1× / 10× / 60× speed, fog and low-visibility rules, a runway closure, and light/dark theme.

## Run it

- **Simulation only:** open `index.html` in any modern browser. Nothing needs installing.
- **Live data:** install Python 3, then run `python serve.py` in this folder and open http://localhost:8790. The dashboard switches to live mode by itself, and the **Live data** button switches back to the simulation.

## Live data

Panels tagged **LIVE** use real feeds, fetched by `serve.py` (the providers don't let a web page call them directly):

| Feed | Source | Key needed |
|---|---|---|
| Aircraft positions on a satellite map, aircraft on the airport, landings and take-offs, runway direction, emergency squawks | OpenSky Network (main) + adsb.lol | No. A free OpenSky account makes positions refresh about every 25 s instead of every 4 min |
| Weather | VIDP METAR from aviationweather.gov | No |
| Arrivals and departures boards, movements, on-time % | AeroDataBox (RapidAPI) | Yes: the free Basic plan allows about 200 board refreshes a month, so the default refresh is every 4 h |

To add keys, copy `config.example.json` to `config.json` and fill it in. `config.json` is git-ignored, so the keys stay on your PC.

Panels tagged **SIM** stay simulated: passengers, queues, bags, cargo, turnarounds and background systems have no public data source and would come from the airport's own systems.

The free feeds are for personal, non-commercial use, and ADS-B coverage over India depends on volunteer receivers, so some aircraft may be missing or late.
