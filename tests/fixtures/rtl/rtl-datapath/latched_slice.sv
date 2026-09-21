// A clocked assignment that latches part of a wider signal: the 16-bit register
// takes wide_i[15:0], so the draft must draw a split, not feed 32 bits into a
// 16-bit lane.
module latched_slice (
  input  logic        clk_i,
  input  logic        rst_ni,
  input  logic        load_i,
  input  logic [31:0] wide_i,
  output logic [15:0] low_o,
  output logic [31:0] full_o
);
  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      low_o  <= '0;
      full_o <= '0;
    end else if (load_i) begin
      low_o  <= wide_i[15:0];
      full_o <= wide_i;
    end
  end
endmodule
