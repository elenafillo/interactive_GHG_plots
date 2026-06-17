# interactive_GHG_plots

Visualising ACRG data. Replace the data folder with a provided zip.

Please install the environment from the `env.yml` file.

TODO: Write better docstrings!

Follow [the notebook](interactive_plots.py) to plot 
1) the sensitivity footprints, 
2) the timeseries of measurements for a particular site and 
3) maps of estimated man-made emissions.

As an example, I'm using a sensor placed in the Ridge Hill (RGL) transmitting station, near Bristol! 
We will be focusing on methane.

![Ridge Hill station](https://upload.wikimedia.org/wikipedia/commons/a/a2/Ridge_Hill_Transmitter_-_geograph.org.uk_-_1079716.jpg)
![Google Maps screenshot of Ridge Hill Broadcasting tower](figs/maps_screenshot.png)


## Example plots:
When the sensitivity plume is over the ocean, the air is unpolluted and the observation is low:
![example1](figs/low_obs.png)


When the sensitivity plume is over Europe, the incoming air is polluted and the observation is high. 
Belgium, Netherlands, Germany and the north of France produce a lot of methane! 
![example2](figs/high_obs.png)


In this case, the sensitivity plume is only over the UK and Ireland, so the air is polluted, but not as much as when it comes from Europe.
![example3](figs/medium_obs.png)

## The origin of emissions
This is a map of man-made emissions over UK and part of Europe. Can you identify cities, boat tracks and drilling stations?
![flux](figs/flux.png)
